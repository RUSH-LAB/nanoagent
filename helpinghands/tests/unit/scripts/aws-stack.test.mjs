/**
 * infra/aws/stack.yaml, read as CloudFormation reads it: what each VM's role may read, which
 * traffic each security group admits, and what a deploy relies on (scripts/aws/deploy.mjs).
 * cfn-lint checks the template's schema; these check its intent.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {ROOT, rolloutCommands} from '../../../scripts/aws/deploy.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

// CloudFormation's short forms, each kept as the long form it stands for.
const TAGS = ['Ref', 'Sub', 'GetAtt', 'GetAZs', 'Select'].flatMap(name => ['scalar', 'sequence', 'mapping'].map(kind => new yaml.Type(`!${name}`, {
  kind,
  construct: data => ({[name === 'Ref' ? 'Ref' : `Fn::${name}`]: data}),
})));
const template = yaml.load(fs.readFileSync(path.join(ROOT, 'infra/aws/stack.yaml'), 'utf8'), {schema: yaml.DEFAULT_SCHEMA.extend(TAGS)});
const resources = template.Resources;
const PARAMETER_READS = ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'ssm:GetParameterHistory'];
const parameterArn = suffix => `arn:\${AWS::Partition}:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter/rush-lab/\${AWS::StackName}/${suffix}`;
const statements = role => resources[role].Properties.Policies.flatMap(policy => policy.PolicyDocument.Statement);
const subs = list => list.map(entry => entry['Fn::Sub']);

describe('what each VM\'s role may read (infra/aws/stack.yaml)', () => {
  for (const [role, own] of [['WebRole', 'web'], ['RunnerRole', 'runner']]) {
    it(`${role} reads only its own and the shared settings, though Session Manager's policy reads every parameter`, () => {
      assert.deepEqual(resources[role].Properties.ManagedPolicyArns, [{'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore'}]);
      const mine = [parameterArn('shared'), parameterArn('shared/*'), parameterArn(own), parameterArn(`${own}/*`)];
      const denied = statements(role).filter(statement => statement.Effect === 'Deny');
      assert.equal(denied.length, 1);
      assert.deepEqual(denied[0].Action, PARAMETER_READS);
      assert.deepEqual(subs(denied[0].NotResource), mine);
      // What it is allowed to read is all within what is not denied.
      const reads = statements(role).filter(statement => statement.Effect === 'Allow' && [].concat(statement.Action).some(action => action.startsWith('ssm:Get')));
      assert.deepEqual(reads.flatMap(statement => subs(statement.Resource)), mine);
    });
  }

  it('lets neither role read the other\'s settings', () => {
    const notDenied = role => subs(statements(role).find(statement => statement.Effect === 'Deny').NotResource);
    assert.equal(notDenied('RunnerRole').some(arn => arn.includes('/web')), false);
    assert.equal(notDenied('WebRole').some(arn => arn.includes('/runner')), false);
  });
});

describe('which traffic each security group admits', () => {
  it('keeps every rule inline, as a group\'s inline rules replace any of its rules made elsewhere', () => {
    const standalone = Object.entries(resources).filter(([, resource]) => /^AWS::EC2::SecurityGroup(Ingress|Egress)$/.test(resource.Type));
    assert.deepEqual(standalone.map(([name]) => name), []);
  });

  it('admits to NanoAgent only the website, and lets the runner out only on HTTPS', () => {
    const runner = resources.RunnerSecurityGroup.Properties;
    assert.deepEqual(runner.SecurityGroupIngress.map(({IpProtocol, FromPort, ToPort, SourceSecurityGroupId, CidrIp}) => ({IpProtocol, FromPort, ToPort, SourceSecurityGroupId, CidrIp})), [
      {IpProtocol: 'tcp', FromPort: 8787, ToPort: 8787, SourceSecurityGroupId: {Ref: 'WebSecurityGroup'}, CidrIp: undefined},
    ]);
    assert.deepEqual(runner.SecurityGroupEgress.map(({IpProtocol, FromPort, ToPort, CidrIp}) => ({IpProtocol, FromPort, ToPort, CidrIp})), [
      {IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0'},
    ]);
    const web = resources.WebSecurityGroup.Properties;
    assert.deepEqual(web.SecurityGroupEgress.map(({FromPort, CidrIp}) => [FromPort, CidrIp]), [
      [443, '0.0.0.0/0'], [5432, '0.0.0.0/0'], [8787, {'Fn::GetAtt': 'Vpc.CidrBlock'}],
    ]);
  });
});

describe('what a deploy relies on', () => {
  it('runs a fixed image, which deploy.mjs gives, as a new one replaces both VMs', () => {
    assert.deepEqual(template.Parameters.ImageId, {Type: 'AWS::EC2::Image::Id', Description: 'The Amazon Linux 2023 arm64 image both VMs run.'});
  });

  for (const instance of ['WebInstance', 'RunnerInstance']) {
    it(`${instance} boots once its route out is there, keeps its credentials from containers, and marks its first boot done last`, () => {
      const {DependsOn, Properties} = resources[instance];
      assert.deepEqual(DependsOn, ['DefaultRoute', 'SubnetRoutes']);
      assert.deepEqual(Properties.MetadataOptions, {HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled'});
      const boot = Properties.UserData['Fn::Base64']['Fn::Sub'].trim().split('\n');
      assert.equal(boot.at(-1).trim(), 'touch /etc/rush-lab/booted');
      // Each deploy's rollout waits for that file (scripts/aws/deploy.mjs).
      assert.ok(rolloutCommands('c', 'web', 'i').some(command => command.includes('test -e /etc/rush-lab/booted')));
    });
  }

  it('gives the website its address once the VPC\'s internet gateway is attached', () => {
    assert.equal(resources.WebAddress.DependsOn, 'GatewayAttachment');
    assert.equal(resources.DefaultRoute.DependsOn, 'GatewayAttachment');
  });
});
