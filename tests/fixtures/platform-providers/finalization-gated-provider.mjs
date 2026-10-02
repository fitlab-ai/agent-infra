import fs from 'node:fs';

function issue(id) {
  return {
    id,
    identity: { kind: 'id', value: id },
    title: 'Finalization test issue',
    body: '',
    state: 'open',
    labels: [],
    assignees: [],
    milestone: null,
    fields: {},
    issueType: { identity: { kind: 'id', value: 'bug-type' }, name: 'Bug', fields: [] },
    displayUrl: `https://example.invalid/issues/${id}`
  };
}

function receipt(remoteId) {
  return { ok: true, value: { remoteId, changed: true } };
}

export default async function createPlatformProvider(input) {
  const { enteredPath, releasePath, callsPath, issueId } = input.config;
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    identity: { issue: 'id', 'pull-request': 'id', comment: 'id' },
    context: {
      async resolve() {
        return {
          ok: true,
          value: {
            type: input.providerType,
            scope: { id: 'test/project', label: 'test/project' },
            currentUser: { id: 'test-agent' },
            capabilities: { authenticated: true, comment: true, triage: true, push: true, admin: false },
            authenticated: true
          }
        };
      }
    },
    issues: {
      async describeRepository() {
        return { ok: true, value: {
          repository: { identity: { kind: 'id', value: 'project' }, name: 'test/project', url: null },
          labels: [], milestones: [],
          issueTypes: [{ identity: { kind: 'id', value: 'bug-type' }, name: 'Bug', fields: [] }],
          fields: []
        } };
      },
      async inspect() { return { ok: true, value: issue(issueId) }; },
      async create() { return receipt('issue-created'); },
      async update() { return receipt('issue-updated'); }
    },
    comments: {
      async list() { return { ok: true, value: [] }; },
      async write() {
        fs.appendFileSync(callsPath, 'write\n');
        fs.writeFileSync(enteredPath, 'entered\n');
        while (!fs.existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 10));
        return receipt('comment-written');
      },
      async delete() { return receipt('comment-deleted'); }
    }
  };
}
