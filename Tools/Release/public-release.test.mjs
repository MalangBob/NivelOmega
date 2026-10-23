import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assetFingerprint, validateRelease, GitHubReleaseApi } from './public-release.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const asset = name => ({ id: 1, name, size: 4, digest: `sha256:${hash(name)}`, state: 'uploaded' });
const clientAssets = [
  'client-update.json', 'NivelOmega-1.2.3-android.apk', 'NivelOmega-1.2.3-full.nupkg',
  'NivelOmega-win-Portable.zip', 'NivelOmega-win-Setup.exe', 'releases.win.json'
].map(asset);
const dataAssets = ['cards_all.json', 'data-release.json', 'restrictions.json'].map(asset);

test('only exact, hashed draft assets are accepted', () => {
  const draft = { id: 1, tag_name: 'v1.2.3', name: '1.2.3', draft: true, prerelease: false,
    assets: clientAssets };
  const fingerprint = assetFingerprint(clientAssets);
  assert.equal(validateRelease('MalangBob/NivelOmega', draft, 'v1.2.3', fingerprint), draft);
  assert.throws(() => validateRelease('MalangBob/NivelOmega', { ...draft, draft: false }, 'v1.2.3', fingerprint),
    /stable release draft/);
  assert.equal(validateRelease('MalangBob/NivelOmega', { ...draft, draft: false }, 'v1.2.3', fingerprint, true).id, 1);
  assert.throws(() => validateRelease('MalangBob/NivelOmega', { ...draft, assets: [...clientAssets, asset('source.cs')] },
    'v1.2.3', fingerprint), /allowlist/);
  assert.throws(() => validateRelease('MalangBob/NivelOmega', draft, 'v1.2.3', hash('different')), /receipt/);
  assert.equal(validateRelease('MalangBob/NivelOmegaData', { ...draft, assets: dataAssets },
    'v1.2.3', assetFingerprint(dataAssets)).id, 1);
});

test('publishing an older draft preserves the latest release', async () => {
  const calls = [];
  const api = new GitHubReleaseApi('test-token', async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    return Response.json(options.method ? {} : { tag_name: 'v2.0.0' });
  });
  await api.publish('MalangBob/NivelOmega', { id: 7, draft: true }, 1002003);
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].body), { draft: false, make_latest: 'false' });
});

test('draft lookup uses the release listing when the tag endpoint returns 404', async () => {
  const draft = { id: 7, tag_name: 'v1.2.3', name: '1.2.3', draft: true, prerelease: false,
    assets: clientAssets };
  const calls = [];
  const api = new GitHubReleaseApi('test-token', async url => {
    calls.push(url);
    if (url.includes('/releases/tags/')) return new Response(null, { status: 404 });
    if (url.includes('/releases?')) return Response.json([draft]);
    throw new Error(`Unexpected request: ${url}`);
  });
  assert.equal((await api.draft('MalangBob/NivelOmega', 'v1.2.3', assetFingerprint(clientAssets))).id, draft.id);
  assert.equal(calls.length, 2);
});
