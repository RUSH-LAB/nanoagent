/**
 * scripts/aws/deploy.mjs: every command a deploy runs, against a scripted git, AWS CLI and Docker,
 * in order, and every refusal before anything changes.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CONFIG, LATEST_IMAGE, MAIL, REQUIRED, ROOT, deploy, missingParameters, readConfig, rolloutCommands} from '../../../scripts/aws/deploy.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const CONFIG_TEXT = `stack: test-stack
region: us-east-2
domain: lab.example.org
branch: production
repository: https://github.com/RUSH-LAB/nanoagent
web_instance_type: t4g.small
runner_instance_type: t4g.medium
`;
const config = readConfig(CONFIG_TEXT);
const ALL = [...Object.entries(REQUIRED).flatMap(([where, names]) => names.map(name => `${where}/${name}`)), 'web/RESEND_API_KEY', 'web/MAIL_FROM', 'web/NANOAGENT_URL'];
const OUTPUTS = {
  WebAddress: '203.0.113.7',
  WebInstance: 'i-web',
  RunnerInstance: 'i-runner',
  WebRepository: '111122223333.dkr.ecr.us-east-2.amazonaws.com/web',
  RunnerRepository: '111122223333.dkr.ecr.us-east-2.amazonaws.com/runner',
};

/** git, the AWS CLI and Docker, scripted: what each scenario answers, and every command asked. */
function scripted({status = '', ancestor = true, parameters = ALL, stack = 'UPDATE_COMPLETE', pushed = [], invocations = {runner: ['InProgress', 'Success'], web: ['Success']}, failing = {}} = {}) {
  const calls = [];
  const inputs = [];
  const left = {runner: [...invocations.runner], web: [...invocations.web]};
  const run = (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (options.input !== undefined) inputs.push(options.input);
    if (command === 'git') {
      if (args[0] === 'status') return status;
      if (args[0] === 'rev-parse') return `${COMMIT}\n`;
      if (args[0] === 'fetch') return '';
      if (args[0] === 'merge-base') {
        if (!ancestor) throw new Error('Command failed: git merge-base');
        return '';
      }
    }
    if (command === 'aws' && args[0] === 'ssm' && args[1] === 'get-parameters-by-path') return JSON.stringify(parameters.map(name => `/rush-lab/test-stack/${name}`));
    if (command === 'aws' && args[0] === 'cloudformation' && args[1] === 'deploy') return '';
    if (command === 'aws' && args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
      // Whether the stack is there, as a listing filtered by its name: empty when it is not.
      if (args[args.indexOf('--query') + 1] === "Stacks[?StackName=='test-stack'].StackStatus") return `${stack}\n`;
      return JSON.stringify(Object.entries(OUTPUTS).map(([OutputKey, OutputValue]) => ({OutputKey, OutputValue})));
    }
    if (command === 'aws' && args[0] === 'ssm' && args[1] === 'get-parameter') return 'ami-0fedcba9876543210\n';
    if (command === 'aws' && args[0] === 'ecr' && args[1] === 'get-login-password') return 'ecr-password-never-on-a-command-line';
    if (command === 'aws' && args[0] === 'ecr' && args[1] === 'batch-get-image') {
      const image = `${args[args.indexOf('--repository-name') + 1]}:${args[args.indexOf('--image-ids') + 1].replace('imageTag=', '')}`;
      return JSON.stringify(pushed.includes(image) ? [image.split(':')[1]] : []);
    }
    if (command === 'aws' && args[0] === 'ssm' && args[1] === 'send-command') return `${args[args.indexOf('--instance-ids') + 1]}-command\n`;
    if (command === 'aws' && args[0] === 'ssm' && args[1] === 'get-command-invocation') {
      const role = args[args.indexOf('--instance-id') + 1] === 'i-runner' ? 'runner' : 'web';
      const Status = left[role].length > 1 ? left[role].shift() : left[role][0];
      return JSON.stringify({Status, StandardOutputContent: `${role} is running the image\n`, StandardErrorContent: failing[role] ?? ''});
    }
    if (command === 'docker') return '';
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  return {run, calls, inputs};
}

const quietly = {sleep: async () => {}, log: () => {}};
const health = (...answers) => {
  const asked = [];
  return {asked, fetchImpl: async url => {
    asked.push(url);
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    return {ok: answer === 200, status: answer};
  }};
};
const names = calls => calls.map(call => call.slice(0, 3).join(' '));

describe('infra/aws/deploy.yaml', () => {
  it('is read with every setting, and the committed one waits for its domain', () => {
    assert.deepEqual({...config}, {
      stack: 'test-stack', region: 'us-east-2', domain: 'lab.example.org', branch: 'production',
      repository: 'https://github.com/RUSH-LAB/nanoagent', web_instance_type: 't4g.small', runner_instance_type: 't4g.medium',
      image_id: null,
    });
    assert.equal(readConfig(`${CONFIG_TEXT}image_id: ami-0123456789abcdef0\n`).image_id, 'ami-0123456789abcdef0');
    assert.throws(() => readConfig(fs.readFileSync(CONFIG, 'utf8')), /must set domain/);
  });

  it('refuses a missing setting, one it does not know, a domain that is not one, and a stack name CloudFormation refuses', () => {
    assert.throws(() => readConfig(CONFIG_TEXT.replace('branch: production\n', '')), /must set branch/);
    assert.throws(() => readConfig(`${CONFIG_TEXT}size: large\n`), /has no setting size/);
    assert.throws(() => readConfig(CONFIG_TEXT.replace('lab.example.org', 'https://lab.example.org')), /is not a domain name/);
    assert.throws(() => readConfig(CONFIG_TEXT.replace('test-stack', 'test_stack!')), /is not a CloudFormation stack name/);
    assert.throws(() => readConfig('- a list'), /must set stack/);
    assert.throws(() => readConfig(`${CONFIG_TEXT}image_id: latest\n`), /image_id latest is not an AMI id/);
    assert.throws(() => readConfig(CONFIG_TEXT.replace('lab.example.org', `${'a'.repeat(40)}.${'b'.repeat(40)}.example.org`)), /over 87 characters, too long for an image tag/);
  });
});

describe('the settings a deploy needs (SSM Parameter Store)', () => {
  it('needs nothing more when every one is set', () => {
    assert.deepEqual(missingParameters(ALL), []);
  });

  it('names each one unset, and the mail settings, one way or the other', () => {
    assert.deepEqual(missingParameters([]), [
      'shared/NANOAGENT_API_TOKEN', 'web/DATABASE_URL', 'web/DATABASE_MIGRATION_URL', 'web/BETTER_AUTH_SECRET', 'web/GITHUB_CLIENT_ID',
      'web/GITHUB_CLIENT_SECRET', 'web/ROOT_GITHUB_LOGIN', 'web/OPENROUTER_MANAGEMENT_KEY', 'runner/OPENROUTER_API_KEY',
      'web/RESEND_API_KEY and web/MAIL_FROM, or web/MAIL_WEBHOOK_URL',
    ]);
    const withoutMail = ALL.filter(name => !name.startsWith('web/RESEND') && !name.startsWith('web/MAIL'));
    assert.deepEqual(missingParameters([...withoutMail, 'web/MAIL_WEBHOOK_URL']), []);
    assert.deepEqual(missingParameters([...withoutMail, 'web/RESEND_API_KEY']), ['web/RESEND_API_KEY and web/MAIL_FROM, or web/MAIL_WEBHOOK_URL']);
    assert.deepEqual(MAIL.map(group => [...group]), [['RESEND_API_KEY', 'MAIL_FROM'], ['MAIL_WEBHOOK_URL']]);
  });
});

describe('what each VM runs to deploy a commit', () => {
  it('waits for the VM\'s first boot, checks the commit out from GitHub, then runs that commit\'s rollout', () => {
    assert.deepEqual(rolloutCommands(COMMIT, 'runner', 'repo/runner:abc'), [
      'set -euo pipefail',
      'for _ in $(seq 120); do test -e /etc/rush-lab/booted && break; sleep 5; done',
      'test -e /etc/rush-lab/booted || { echo "the VM has not finished its first boot: see /var/log/cloud-init-output.log" >&2; exit 1; }',
      'cd /opt/rush-lab/repo',
      `git fetch --quiet origin ${COMMIT}`,
      `git checkout --quiet --detach ${COMMIT}`,
      'helpinghands/infra/aws/rollout.sh runner repo/runner:abc',
    ]);
  });
});

describe('a deploy (scripts/aws/deploy.mjs)', () => {
  it('runs every step in order: commit, settings, stack, images, the runner, then the website, then the site', async () => {
    const {run, calls, inputs} = scripted();
    const {asked, fetchImpl} = health(200);
    const logged = [];
    const result = await deploy({config, run, fetchImpl, sleep: async () => {}, log: line => logged.push(line)});
    assert.equal(result.commit, COMMIT);
    assert.deepEqual(names(calls), [
      'git status --porcelain', 'git rev-parse HEAD', 'git fetch --quiet', 'git merge-base --is-ancestor',
      'aws ssm get-parameters-by-path',
      'aws cloudformation describe-stacks', 'aws cloudformation deploy', 'aws cloudformation describe-stacks',
      'aws ecr get-login-password', 'docker login --username', 'aws ecr batch-get-image', 'docker buildx build', 'aws ecr batch-get-image', 'docker buildx build',
      'aws ssm send-command', 'aws ssm get-command-invocation', 'aws ssm get-command-invocation',
      'aws ssm send-command', 'aws ssm get-command-invocation',
    ]);
    const call = start => calls.find(one => one.join(' ').startsWith(start));
    assert.deepEqual(call('git merge-base'), ['git', 'merge-base', '--is-ancestor', COMMIT, 'origin/production']);
    assert.deepEqual(call('aws cloudformation deploy'), ['aws', 'cloudformation', 'deploy', '--region', 'us-east-2', '--stack-name', 'test-stack',
      '--template-file', path.join(ROOT, 'infra/aws/stack.yaml'), '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset',
      '--parameter-overrides', 'Domain=lab.example.org', 'WebInstanceType=t4g.small', 'RunnerInstanceType=t4g.medium',
      'Repository=https://github.com/RUSH-LAB/nanoagent']);
    const builds = calls.filter(one => one[1] === 'buildx');
    assert.deepEqual(builds[0], ['docker', 'buildx', 'build', '--platform', 'linux/arm64', '--tag', `${OUTPUTS.RunnerRepository}:${COMMIT}`, '--push', path.join(ROOT, '../nanoagent')]);
    assert.deepEqual(builds[1], ['docker', 'buildx', 'build', '--platform', 'linux/arm64', '--tag', `${OUTPUTS.WebRepository}:${COMMIT}-lab.example.org`, '--push', '--build-arg', 'SITE_URL=https://lab.example.org', ROOT]);
    assert.deepEqual(calls.filter(one => one[2] === 'batch-get-image').map(one => one.slice(3)), [
      ['--repository-name', 'runner', '--image-ids', `imageTag=${COMMIT}`, '--query', 'images[].imageId.imageTag', '--output', 'json', '--region', 'us-east-2'],
      ['--repository-name', 'web', '--image-ids', `imageTag=${COMMIT}-lab.example.org`, '--query', 'images[].imageId.imageTag', '--output', 'json', '--region', 'us-east-2'],
    ]);
    const sends = calls.filter(one => one[2] === 'send-command');
    assert.deepEqual(sends.map(one => one[one.indexOf('--instance-ids') + 1]), ['i-runner', 'i-web']);
    assert.deepEqual(JSON.parse(sends[0][sends[0].indexOf('--parameters') + 1]), {
      commands: rolloutCommands(COMMIT, 'runner', `${OUTPUTS.RunnerRepository}:${COMMIT}`), executionTimeout: ['1800'],
    });
    assert.deepEqual(JSON.parse(sends[1][sends[1].indexOf('--parameters') + 1]).commands.at(-1), `helpinghands/infra/aws/rollout.sh web ${OUTPUTS.WebRepository}:${COMMIT}-lab.example.org`);
    // The registry password goes to Docker on its standard input, never on a command line.
    assert.deepEqual(inputs, ['ecr-password-never-on-a-command-line']);
    assert.ok(calls.every(one => !one.join(' ').includes('ecr-password')));
    assert.deepEqual(asked, ['https://lab.example.org/api/health']);
    assert.match(logged.at(-1), new RegExp(`https://lab.example.org is up, running ${COMMIT}`));
  });

  it('keeps the VMs\' image: the latest Amazon Linux 2023 for a new stack, the stack\'s own after, deploy.yaml\'s when it names one', async () => {
    const overrides = calls => calls.find(one => one[2] === 'deploy').slice(calls.find(one => one[2] === 'deploy').indexOf('--parameter-overrides') + 1);
    // A stack that is there keeps the image it has: no ImageId, which CloudFormation then keeps.
    const kept = scripted();
    await deploy({config, run: kept.run, ...quietly, fetchImpl: health(200).fetchImpl});
    assert.equal(overrides(kept.calls).some(value => value.startsWith('ImageId=')), false);
    assert.equal(kept.calls.some(one => one[2] === 'get-parameter'), false);
    // A new stack: the latest, read from AWS's public parameter.
    const created = scripted({stack: ''});
    await deploy({config, run: created.run, ...quietly, fetchImpl: health(200).fetchImpl});
    assert.deepEqual(created.calls.find(one => one[2] === 'get-parameter'),
      ['aws', 'ssm', 'get-parameter', '--name', LATEST_IMAGE, '--query', 'Parameter.Value', '--output', 'text', '--region', 'us-east-2']);
    assert.equal(overrides(created.calls).at(-1), 'ImageId=ami-0fedcba9876543210');
    // deploy.yaml's image_id: passed as it is, the stack not asked.
    const moved = scripted();
    await deploy({config: readConfig(`${CONFIG_TEXT}image_id: ami-0123456789abcdef0\n`), run: moved.run, ...quietly, fetchImpl: health(200).fetchImpl});
    assert.equal(overrides(moved.calls).at(-1), 'ImageId=ami-0123456789abcdef0');
    assert.equal(moved.calls.filter(one => one[2] === 'describe-stacks').length, 1);
  });

  it('deploys an image already pushed as it is, as on a rollback or a retry, since a tag cannot be pushed twice', async () => {
    const both = scripted({pushed: [`runner:${COMMIT}`, `web:${COMMIT}-lab.example.org`]});
    await deploy({config, run: both.run, ...quietly, fetchImpl: health(200).fetchImpl});
    assert.equal(both.calls.some(one => one[1] === 'buildx'), false);
    const sends = both.calls.filter(one => one[2] === 'send-command').map(one => JSON.parse(one[one.indexOf('--parameters') + 1]).commands.at(-1));
    assert.deepEqual(sends, [`helpinghands/infra/aws/rollout.sh runner ${OUTPUTS.RunnerRepository}:${COMMIT}`,
      `helpinghands/infra/aws/rollout.sh web ${OUTPUTS.WebRepository}:${COMMIT}-lab.example.org`]);
    // A runner pushed before the website's build failed: only the website's is built.
    const runnerOnly = scripted({pushed: [`runner:${COMMIT}`]});
    await deploy({config, run: runnerOnly.run, ...quietly, fetchImpl: health(200).fetchImpl});
    assert.deepEqual(runnerOnly.calls.filter(one => one[1] === 'buildx').map(one => one.at(-1)), [ROOT]);
    // The same commit for another domain is another website image: its build takes the domain.
    const elsewhere = scripted({pushed: [`runner:${COMMIT}`, `web:${COMMIT}-lab.example.org`]});
    await deploy({config: readConfig(CONFIG_TEXT.replace('lab.example.org', 'rush.example.edu')), run: elsewhere.run, ...quietly, fetchImpl: health(200).fetchImpl});
    assert.deepEqual(elsewhere.calls.filter(one => one[1] === 'buildx').map(one => one[one.indexOf('--tag') + 1]), [`${OUTPUTS.WebRepository}:${COMMIT}-rush.example.edu`]);
  });

  it('builds nothing when ECR cannot say whether an image is there', async () => {
    const {run, calls} = scripted();
    const refusing = (command, args, options) => {
      if (command === 'aws' && args[1] === 'batch-get-image') throw new Error('AccessDeniedException: not authorized to perform ecr:BatchGetImage');
      return run(command, args, options);
    };
    await assert.rejects(deploy({config, run: refusing, ...quietly}), /AccessDeniedException/);
    assert.equal(calls.some(one => one[1] === 'buildx' || one[2] === 'send-command'), false);
  });

  it('deploys nothing from a checkout with uncommitted changes', async () => {
    const {run, calls} = scripted({status: ' M src/server/runner.js\n'});
    await assert.rejects(deploy({config, run, ...quietly}), /uncommitted changes: deploy only a commit/);
    assert.deepEqual(names(calls), ['git status --porcelain']);
  });

  it('deploys nothing that is not on origin/<branch>', async () => {
    const {run, calls} = scripted({ancestor: false});
    await assert.rejects(deploy({config, run, ...quietly}), new RegExp(`${COMMIT} is not on origin/production`));
    assert.ok(calls.every(([command]) => command === 'git'));
  });

  it('changes nothing on AWS while a setting is unset, naming each', async () => {
    const {run, calls} = scripted({parameters: ALL.filter(name => name !== 'runner/OPENROUTER_API_KEY' && name !== 'web/DATABASE_URL')});
    await assert.rejects(deploy({config, run, ...quietly}), /under \/rush-lab\/test-stack\/ first: web\/DATABASE_URL; runner\/OPENROUTER_API_KEY$/);
    assert.equal(calls.some(one => one[1] === 'cloudformation'), false);
  });

  it('stops at a runner rollout that fails, before the website, saying why', async () => {
    const {run, calls} = scripted({invocations: {runner: ['InProgress', 'Failed'], web: ['Success']}, failing: {runner: 'the runner did not answer /health'}});
    await assert.rejects(deploy({config, run, ...quietly}), /the runner rollout ended Failed \(SSM command i-runner-command\):\nthe runner did not answer \/health/);
    assert.deepEqual(calls.filter(one => one[2] === 'send-command').map(one => one[one.indexOf('--instance-ids') + 1]), ['i-runner']);
  });

  it('gives up on a rollout that does not finish in time', async () => {
    const {run} = scripted({invocations: {runner: ['InProgress'], web: ['Success']}});
    await assert.rejects(deploy({config, run, ...quietly, rolloutSeconds: 10}), /the runner rollout did not finish within 10 s/);
  });

  it('waits for the site while its certificate and DNS arrive, and says what to check when they do not', async () => {
    const waiting = health(new Error('getaddrinfo ENOTFOUND'), 502, 200);
    await deploy({config, run: scripted().run, ...quietly, fetchImpl: waiting.fetchImpl});
    assert.equal(waiting.asked.length, 3);
    const never = health(new Error('certificate not yet issued'));
    await assert.rejects(deploy({config, run: scripted().run, ...quietly, fetchImpl: never.fetchImpl, healthSeconds: 30}), /did not answer within 30 s: is the domain's A record 203\.0\.113\.7\?/);
  });

  it('runs nothing on AWS or Docker in a dry run, saying all it would run, the runner first', async () => {
    const {run, calls} = scripted();
    const logged = [];
    await deploy({config, run, dryRun: true, sleep: async () => {}, log: line => logged.push(line), fetchImpl: async () => assert.fail('no site is asked')});
    assert.ok(calls.every(([command]) => command === 'git'), names(calls).join(', '));
    const would = logged.filter(line => line.startsWith('would run'));
    assert.deepEqual(would.map(line => line.split(': ')[1].split(' ').slice(0, 3).join(' ')), [
      'aws cloudformation deploy', 'docker login --username', 'docker buildx build', 'docker buildx build', 'aws ssm send-command', 'aws ssm send-command',
    ]);
    assert.match(would[2], /^would run, unless <RunnerRepository> has 0123456789abcdef0123456789abcdef01234567 already: /);
    assert.match(would[3], /^would run, unless <WebRepository> has 0123456789abcdef0123456789abcdef01234567-lab\.example\.org already: .*--tag <WebRepository>:0123456789abcdef0123456789abcdef01234567-lab\.example\.org --push --build-arg SITE_URL=https:\/\/lab\.example\.org /);
    assert.match(would[4], /--instance-ids <RunnerInstance>/);
    assert.match(would[5], /--instance-ids <WebInstance>/);
    assert.ok(logged.some(line => line.startsWith('would check every parameter under /rush-lab/test-stack/')));
    assert.ok(logged.some(line => line.startsWith('would keep the stack\'s image, or give a new stack the latest Amazon Linux 2023')));
  });
});
