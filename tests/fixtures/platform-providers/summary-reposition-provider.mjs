import fs from 'node:fs';

function readState(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeState(path, state) {
  fs.writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export default async function createPlatformProvider(input) {
  const config = input.config;
  const issue = {
    id: '7', identity: { kind: 'number', value: 7 }, number: 7,
    title: 'Fixture issue', body: '', state: 'open', labels: [], assignees: [], milestone: null, fields: {}
  };
  const receipt = (id) => ({ ok: true, value: { remoteId: String(id), changed: true } });
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    identity: { issue: 'number', 'pull-request': 'number', comment: 'id', release: 'key' },
    context: {
      async resolve() {
        return { ok: true, value: {
          type: input.providerType, scope: { id: 'acme/widgets', label: 'acme/widgets' },
          currentUser: { name: 'codex' },
          capabilities: { authenticated: true, comment: true, triage: true, push: true, admin: false },
          authenticated: true
        } };
      }
    },
    issues: {
      async inspect() { return { ok: true, value: issue }; },
      async describeRepository() { return { ok: true, value: {
        repository: { identity: { kind: 'id', value: 'acme/widgets' }, name: 'acme/widgets', url: null },
        labels: [], milestones: [], issueTypes: [], fields: []
      } }; },
      async create() { return receipt('issue-created'); },
      async update() { return receipt('issue-updated'); }
    },
    comments: {
      async list() { return { ok: true, value: readState(config.statePath).comments }; },
      async write(request) {
        const state = readState(config.statePath);
        state.writeCount += 1;
        const next = {
          id: `comment-${state.nextId++}`, author: { name: 'codex' },
          body: config.corruptSecondWrite && state.writeCount === 2 ? `${request.body}\ncorrupted` : request.body,
          createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
          createdSequence: state.nextSequence++
        };
        state.comments.push(next);
        writeState(config.statePath, state);
        return receipt(next.id);
      },
      async delete(request) {
        const state = readState(config.statePath);
        state.comments = state.comments.filter((comment) => comment.id !== request.comment.value);
        writeState(config.statePath, state);
        return receipt(request.comment.value);
      }
    }
  };
}
