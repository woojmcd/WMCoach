// In-memory stand-in for the parts of the GitHub REST API the app uses:
// refs, commits, trees (with inline content), blobs, contents, repo info.
// Used by the unit tests (as fetch) and by the e2e run (behind page.route).
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha1').update(s).digest('hex');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

export class FakeGitHub {
  constructor({ owner = 'woojmcd', repo = 'WMCoach', branch = 'main', token = 'github_pat_test', files = {} } = {}) {
    Object.assign(this, { owner, repo, branch, token });
    this.blobs = new Map();
    this.trees = new Map(); // sha -> Map(path -> blobSha)
    this.commits = new Map(); // sha -> { tree, parents, message }
    this.log = []; // requests, for assertions
    this.failNext = []; // [{ match: /regex/, status }] injected failures
    this.beforeUpdateRef = null; // hook to simulate a concurrent push
    const tree = this.putTree(new Map(Object.entries(files).map(([p, c]) => [p, this.putBlob(c)])));
    const c = sha(`init${tree}`);
    this.commits.set(c, { tree, parents: [], message: 'init' });
    this.refs = { [branch]: c };
  }

  putBlob(content) {
    const s = sha(`blob ${content}`);
    this.blobs.set(s, content);
    return s;
  }

  putTree(map) {
    const s = sha(`tree ${[...map.entries()].sort().join(';')}`);
    this.trees.set(s, map);
    return s;
  }

  // Files at the branch head: { path: content }.
  files(branch = this.branch) {
    const tree = this.trees.get(this.commits.get(this.refs[branch]).tree);
    return Object.fromEntries([...tree.entries()].map(([p, b]) => [p, this.blobs.get(b)]));
  }

  json(path, branch) {
    const f = this.files(branch)[path];
    return f === undefined ? undefined : JSON.parse(f);
  }

  // Simulate someone else (the daily routine) pushing a file.
  externalCommit(path, content, message = 'daily') {
    const head = this.refs[this.branch];
    const map = new Map(this.trees.get(this.commits.get(head).tree));
    map.set(path, this.putBlob(content));
    const tree = this.putTree(map);
    const c = sha(`${message}${tree}${head}${Math.random()}`);
    this.commits.set(c, { tree, parents: [head], message });
    this.refs[this.branch] = c;
    return c;
  }

  commitMessages() {
    const out = [];
    let c = this.refs[this.branch];
    while (c) {
      const commit = this.commits.get(c);
      out.push(commit.message);
      c = commit.parents[0];
    }
    return out;
  }

  // { method, url, headers, body } -> { status, body }
  handle({ method, url, headers = {}, body = null }) {
    const u = new URL(url);
    this.log.push(`${method} ${u.pathname}${u.search}`);
    const auth = headers.Authorization || headers.authorization;
    if (auth !== `Bearer ${this.token}`) return { status: 401, body: { message: 'Bad credentials' } };
    const fail = this.failNext.findIndex((f) => f.match.test(`${method} ${u.pathname}`));
    if (fail >= 0) {
      const f = this.failNext.splice(fail, 1)[0];
      return { status: f.status, body: { message: f.message || 'injected failure' } };
    }
    const prefix = `/repos/${this.owner}/${this.repo}`;
    if (!u.pathname.startsWith(prefix)) return { status: 404, body: { message: 'Not Found' } };
    const p = decodeURIComponent(u.pathname.slice(prefix.length));
    const data = body ? JSON.parse(body) : null;
    let m;
    if (method === 'GET' && p === '') return { status: 200, body: { full_name: `${this.owner}/${this.repo}`, private: false, default_branch: this.branch, permissions: { push: true } } };
    if (method === 'GET' && (m = p.match(/^\/git\/ref\/heads\/(.+)$/))) {
      return this.refs[m[1]] ? { status: 200, body: { object: { sha: this.refs[m[1]] } } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'GET' && (m = p.match(/^\/git\/commits\/(\w+)$/))) {
      const c = this.commits.get(m[1]);
      return c ? { status: 200, body: { sha: m[1], tree: { sha: c.tree } } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'GET' && (m = p.match(/^\/contents\/(.+)$/))) {
      const ref = u.searchParams.get('ref') || this.refs[this.branch];
      const c = this.commits.get(ref) || this.commits.get(this.refs[ref]);
      const blob = c && this.trees.get(c.tree).get(m[1]);
      return blob ? { status: 200, body: { type: 'file', encoding: 'base64', sha: blob, content: b64(this.blobs.get(blob)).replace(/(.{60})/g, '$1\n') } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'GET' && (m = p.match(/^\/git\/trees\/(\w+)$/))) {
      const c = this.commits.get(m[1]) || this.commits.get(this.refs[m[1]]);
      const tree = c ? this.trees.get(c.tree) : this.trees.get(m[1]);
      if (!tree) return { status: 404, body: { message: 'Not Found' } };
      return { status: 200, body: { truncated: false, tree: [...tree.entries()].map(([path, s]) => ({ path, type: 'blob', sha: s, mode: '100644' })) } };
    }
    if (method === 'GET' && (m = p.match(/^\/git\/blobs\/(\w+)$/))) {
      return this.blobs.has(m[1]) ? { status: 200, body: { sha: m[1], encoding: 'base64', content: b64(this.blobs.get(m[1])) } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'POST' && p === '/git/trees') {
      const base = this.trees.get(data.base_tree);
      if (!base) return { status: 422, body: { message: 'Invalid base_tree' } };
      const map = new Map(base);
      for (const e of data.tree) map.set(e.path, this.putBlob(e.content));
      return { status: 201, body: { sha: this.putTree(map) } };
    }
    if (method === 'POST' && p === '/git/commits') {
      const c = sha(`${data.message}${data.tree}${data.parents.join()}${Math.random()}`);
      this.commits.set(c, { tree: data.tree, parents: data.parents, message: data.message });
      return { status: 201, body: { sha: c } };
    }
    if (method === 'PATCH' && (m = p.match(/^\/git\/refs\/heads\/(.+)$/))) {
      if (this.beforeUpdateRef) { const fn = this.beforeUpdateRef; this.beforeUpdateRef = null; fn(); }
      const c = this.commits.get(data.sha);
      if (!c) return { status: 422, body: { message: 'Object does not exist' } };
      if (!data.force && c.parents[0] !== this.refs[m[1]]) return { status: 422, body: { message: 'Update is not a fast forward' } };
      this.refs[m[1]] = data.sha;
      return { status: 200, body: { object: { sha: data.sha } } };
    }
    return { status: 404, body: { message: `Not handled: ${method} ${p}` } };
  }

  // A fetch() for Node tests.
  get fetch() {
    return async (url, init = {}) => {
      if (this.offline) throw new TypeError('Failed to fetch');
      const r = this.handle({ method: init.method || 'GET', url, headers: init.headers || {}, body: init.body || null });
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: () => null },
        json: async () => r.body,
      };
    };
  }
}
