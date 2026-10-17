#!/usr/bin/env node

/**
 * Deploys RUSH Lab cloud to AWS (docs/infra/aws-deployment.md) as infra/aws/deploy.yaml says:
 *
 *   npm run aws:deploy                 deploys this checkout's commit
 *   npm run aws:deploy -- --dry-run    prints what it would run, and runs nothing on AWS or Docker
 *
 * In order, stopping at the first step that fails:
 *   1. the commit: a clean checkout whose HEAD is on origin/<branch>, as each VM checks it out
 *   2. the settings: every SSM parameter the containers need is set (REQUIRED, MAIL)
 *   3. the stack: infra/aws/stack.yaml, deployed by CloudFormation. Its VMs keep their image, as a
 *      new one replaces both: a new stack gets the latest Amazon Linux 2023, and deploy.yaml's
 *      image_id, when set, moves them to that one
 *   4. the images: the runner's (../nanoagent) and the website's (.), built for arm64 and pushed
 *      to the stack's repositories, tagged with the commit (the website's also with its domain,
 *      which its build takes). A tag in them never changes, so an image already pushed, as on a
 *      rollback or a retry, is deployed as it is rather than built again
 *   5. the runner, then the website: each VM, once its first boot is done, checks out the commit
 *      and runs its infra/aws/rollout.sh, by SSM Run Command, which this waits on
 *   6. the site: https://<domain>/api/health answers
 *
 * It uses the AWS CLI's credentials and Docker with buildx; it keeps no secret and prints none.
 */

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const CONFIG = path.join(ROOT, 'infra/aws/deploy.yaml');

// What each VM's containers read from SSM Parameter Store, under /rush-lab/<stack>/<path>/.
// The stack writes web/NANOAGENT_URL itself.
export const REQUIRED = Object.freeze({
  shared: ['NANOAGENT_API_TOKEN'],
  web: ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ROOT_GITHUB_LOGIN', 'OPENROUTER_MANAGEMENT_KEY'],
  runner: ['OPENROUTER_API_KEY'],
});
// And how Mochi sends invitations, one of these (src/server/auth.js productionAuthError).
export const MAIL = Object.freeze([['RESEND_API_KEY', 'MAIL_FROM'], ['MAIL_WEBHOOK_URL']]);

const FIELDS = ['stack', 'region', 'domain', 'branch', 'repository', 'web_instance_type', 'runner_instance_type'];
// null keeps the stack's image; an AMI id moves both VMs to it, replacing them.
const OPTIONAL = ['image_id'];
const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// The image a new stack's VMs get (infra/aws/stack.yaml ImageId).
export const LATEST_IMAGE = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64';

/** deploy.yaml's settings, every one set and of its shape, or an error saying which is not. */
export function readConfig(text) {
  const config = yaml.load(text);
  if (!config || typeof config !== 'object') throw new Error('infra/aws/deploy.yaml must be a mapping');
  for (const field of FIELDS) {
    if (typeof config[field] !== 'string' || !config[field]) throw new Error(`infra/aws/deploy.yaml must set ${field}`);
  }
  const unknown = Object.keys(config).filter(field => !FIELDS.includes(field) && !OPTIONAL.includes(field));
  if (unknown.length) throw new Error(`infra/aws/deploy.yaml has no setting ${unknown.join(', ')}`);
  if (!HOSTNAME.test(config.domain)) throw new Error(`domain ${config.domain} is not a domain name`);
  // The website's image tag is <commit>-<domain>, and Docker refuses a tag over 128 characters.
  if (config.domain.length > 87) throw new Error(`domain ${config.domain} is over 87 characters, too long for an image tag`);
  if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(config.stack)) throw new Error(`stack ${config.stack} is not a CloudFormation stack name`);
  if (config.image_id != null && !/^ami-[0-9a-f]{8,17}$/.test(config.image_id)) throw new Error(`image_id ${config.image_id} is not an AMI id`);
  return Object.freeze({...config, image_id: config.image_id ?? null});
}

/** The parameters `names` (as set under /rush-lab/<stack>/) leave unset: `shared/NAME` and the like. */
export function missingParameters(names) {
  const set = new Set(names);
  const missing = Object.entries(REQUIRED).flatMap(([where, list]) => list.filter(name => !set.has(`${where}/${name}`)).map(name => `${where}/${name}`));
  if (!MAIL.some(group => group.every(name => set.has(`web/${name}`)))) {
    missing.push(MAIL.map(group => group.map(name => `web/${name}`).join(' and ')).join(', or '));
  }
  return missing;
}

/**
 * What one VM runs to deploy `commit`: wait for its first boot (infra/aws/stack.yaml UserData) to be
 * done, as a new VM is Run Command's before it is, check the commit out, then its rollout of
 * `role` on `image`.
 */
export function rolloutCommands(commit, role, image) {
  return [
    'set -euo pipefail',
    'for _ in $(seq 120); do test -e /etc/rush-lab/booted && break; sleep 5; done',
    'test -e /etc/rush-lab/booted || { echo "the VM has not finished its first boot: see /var/log/cloud-init-output.log" >&2; exit 1; }',
    'cd /opt/rush-lab/repo',
    `git fetch --quiet origin ${commit}`,
    `git checkout --quiet --detach ${commit}`,
    `helpinghands/infra/aws/rollout.sh ${role} ${image}`,
  ];
}

/**
 * Deploy as `config` says. `run(command, args, {input})` runs one command and answers its output,
 * throwing when it fails; `fetchImpl` asks the site; `sleep(ms)` waits; `log` reports each step.
 * With `dryRun`, every AWS and Docker command is logged instead of run.
 */
export async function deploy({config, run, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log, dryRun = false, rolloutSeconds = 1800, healthSeconds = 600}) {
  const git = (...args) => run('git', args).trim();
  const aws = (...args) => run('aws', [...args, '--region', config.region]);
  const act = (command, args, options) => {
    if (dryRun) {
      log(`would run: ${command} ${args.join(' ')}`);
      return '';
    }
    return run(command, args, options);
  };

  // 1. The commit.
  if (git('status', '--porcelain')) throw new Error('the checkout has uncommitted changes: deploy only a commit');
  const commit = git('rev-parse', 'HEAD');
  git('fetch', '--quiet', 'origin', config.branch);
  try {
    git('merge-base', '--is-ancestor', commit, `origin/${config.branch}`);
  } catch {
    throw new Error(`${commit} is not on origin/${config.branch}: deploy only a commit pushed there`);
  }
  log(`commit ${commit} (on origin/${config.branch})`);

  const prefix = `/rush-lab/${config.stack}/`;
  if (dryRun) {
    log(`would check every parameter under ${prefix} is set: ${[...Object.entries(REQUIRED).flatMap(([where, list]) => list.map(name => `${where}/${name}`)), 'and the mail settings'].join(', ')}`);
  } else {
    // 2. The settings.
    const listed = JSON.parse(aws('ssm', 'get-parameters-by-path', '--path', prefix, '--recursive', '--query', 'Parameters[].Name', '--output', 'json'));
    const missing = missingParameters(listed.map(name => name.slice(prefix.length)));
    if (missing.length) throw new Error(`set these in SSM Parameter Store under ${prefix} first: ${missing.join('; ')}`);
    log(`settings: every parameter under ${prefix} is set`);
  }

  // 3. The stack. A parameter not given keeps the stack's value, as its image does.
  let image = config.image_id;
  if (!image && dryRun) {
    log(`would keep the stack's image, or give a new stack the latest Amazon Linux 2023 (${LATEST_IMAGE})`);
  } else if (!image) {
    const status = aws('cloudformation', 'describe-stacks', '--query', `Stacks[?StackName=='${config.stack}'].StackStatus`, '--output', 'text').trim();
    if (!status) {
      image = aws('ssm', 'get-parameter', '--name', LATEST_IMAGE, '--query', 'Parameter.Value', '--output', 'text').trim();
      log(`a new stack: its VMs run ${image}, the latest Amazon Linux 2023`);
    }
  }
  act('aws', ['cloudformation', 'deploy', '--region', config.region, '--stack-name', config.stack,
    '--template-file', path.join(ROOT, 'infra/aws/stack.yaml'), '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset',
    '--parameter-overrides', `Domain=${config.domain}`, `WebInstanceType=${config.web_instance_type}`,
    `RunnerInstanceType=${config.runner_instance_type}`, `Repository=${config.repository}`, ...(image ? [`ImageId=${image}`] : [])]);
  const outputs = dryRun
    ? {WebRepository: '<WebRepository>', RunnerRepository: '<RunnerRepository>', WebInstance: '<WebInstance>', RunnerInstance: '<RunnerInstance>', WebAddress: '<WebAddress>'}
    : Object.fromEntries(JSON.parse(aws('cloudformation', 'describe-stacks', '--stack-name', config.stack, '--query', 'Stacks[0].Outputs', '--output', 'json'))
      .map(output => [output.OutputKey, output.OutputValue]));
  log(`stack ${config.stack}: ${config.domain} goes to ${outputs.WebAddress}`);

  // 4. The images. The repositories' tags never change: an image already pushed is the one to deploy.
  const runnerImage = `${outputs.RunnerRepository}:${commit}`;
  const webImage = `${outputs.WebRepository}:${commit}-${config.domain}`;
  const registry = outputs.WebRepository.split('/')[0];
  const password = dryRun ? '' : aws('ecr', 'get-login-password');
  act('docker', ['login', '--username', 'AWS', '--password-stdin', registry], {input: password});
  for (const [image, build] of [
    [runnerImage, [path.join(ROOT, '../nanoagent')]],
    [webImage, ['--build-arg', `SITE_URL=https://${config.domain}`, ROOT]],
  ]) {
    const [repository, tag] = [image.slice(image.indexOf('/') + 1, image.lastIndexOf(':')), image.slice(image.lastIndexOf(':') + 1)];
    if (dryRun) {
      log(`would run, unless ${repository} has ${tag} already: docker buildx build --platform linux/arm64 --tag ${image} --push ${build.join(' ')}`);
      continue;
    }
    const pushed = JSON.parse(aws('ecr', 'batch-get-image', '--repository-name', repository, '--image-ids', `imageTag=${tag}`,
      '--query', 'images[].imageId.imageTag', '--output', 'json'));
    if (pushed.length) {
      log(`image ${image}: already pushed`);
      continue;
    }
    run('docker', ['buildx', 'build', '--platform', 'linux/arm64', '--tag', image, '--push', ...build.slice(0, -1), build.at(-1)]);
    log(`image ${image}: built and pushed`);
  }

  // 5. The runner, then the website: the website's NanoAgent calls go to the runner.
  for (const [role, instance, image] of [['runner', outputs.RunnerInstance, runnerImage], ['web', outputs.WebInstance, webImage]]) {
    const parameters = JSON.stringify({commands: rolloutCommands(commit, role, image), executionTimeout: [String(rolloutSeconds)]});
    const id = act('aws', ['ssm', 'send-command', '--region', config.region, '--instance-ids', instance, '--document-name', 'AWS-RunShellScript',
      '--comment', `RUSH Lab cloud ${role} ${commit.slice(0, 12)}`, '--parameters', parameters, '--query', 'Command.CommandId', '--output', 'text']).trim();
    if (dryRun) continue;
    let invocation;
    for (let waited = 0; ; waited += 5) {
      await sleep(5000);
      try {
        invocation = JSON.parse(aws('ssm', 'get-command-invocation', '--command-id', id, '--instance-id', instance, '--output', 'json'));
      } catch {
        // Not yet registered with the instance.
        invocation = {Status: 'Pending'};
      }
      if (!['Pending', 'InProgress', 'Delayed'].includes(invocation.Status)) break;
      if (waited > rolloutSeconds + 60) throw new Error(`the ${role} rollout did not finish within ${rolloutSeconds} s (SSM command ${id})`);
    }
    if (invocation.Status !== 'Success') {
      throw new Error(`the ${role} rollout ended ${invocation.Status} (SSM command ${id}):\n${invocation.StandardErrorContent || invocation.StandardOutputContent || ''}`.trim());
    }
    log(`${role}: ${invocation.StandardOutputContent.trim().split('\n').at(-1)}`);
  }

  // 6. The site.
  if (dryRun) {
    log(`would check https://${config.domain}/api/health answers`);
    return {commit, outputs};
  }
  for (let waited = 0; ; waited += 10) {
    try {
      const response = await fetchImpl(`https://${config.domain}/api/health`);
      if (response.ok) break;
    } catch {
      // The certificate or the DNS may not be there yet.
    }
    if (waited >= healthSeconds) throw new Error(`https://${config.domain}/api/health did not answer within ${healthSeconds} s: is the domain's A record ${outputs.WebAddress}?`);
    await sleep(10_000);
  }
  log(`https://${config.domain} is up, running ${commit}`);
  return {commit, outputs};
}

function runCommand(command, args, {input} = {}) {
  return execFileSync(command, args, {cwd: ROOT, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  Promise.resolve()
    .then(() => deploy({config: readConfig(fs.readFileSync(CONFIG, 'utf8')), run: runCommand, dryRun}))
    .catch(error => {
      console.error(error.message);
      process.exit(1);
    });
}
