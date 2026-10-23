import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const CLIENT_REPO = 'MalangBob/NivelOmega';
const DATA_REPO = 'MalangBob/NivelOmegaData';
const API = 'https://api.github.com';

export function releaseVersion(tag) {
  const match = /^(?:v?)(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(tag ?? '');
  if (!match) throw new Error('Invalid stable release tag.');
  const [, major, minor, patch] = match;
  const versionCode = Number(major) * 1000000 + Number(minor) * 1000 + Number(patch);
  if (Number(major) > 2099 || versionCode < 1 || versionCode > 2100000000)
    throw new Error('Release version is out of range.');
  return { tag, version: `${major}.${minor}.${patch}`, versionCode };
}

export function assetFingerprint(assets) {
  const lines = assets.map(asset => `${asset.name}:${asset.size}:${asset.digest}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function expectedNames(repo, version, actual) {
  if (repo === DATA_REPO) return ['cards_all.json', 'data-release.json', 'restrictions.json'];
  const names = [
    'client-update.json', `NivelOmega-${version}-android.apk`,
    `NivelOmega-${version}-full.nupkg`, 'NivelOmega-win-Portable.zip',
    'NivelOmega-win-Setup.exe', 'releases.win.json'
  ];
  for (const optional of [`NivelOmega-${version}-delta.nupkg`, `NivelOmega-${version}-android.patch.gz`])
    if (actual.includes(optional)) names.push(optional);
  return names.sort();
}

export function validateRelease(repo, release, tag, expectedFingerprint, allowPublished = false) {
  const { version } = releaseVersion(tag);
  if (release.tag_name !== tag || release.name !== version || release.prerelease ||
      (!release.draft && !allowPublished))
    throw new Error(`${repo}: expected the matching stable release draft.`);
  const assets = release.assets ?? [];
  const names = assets.map(asset => asset.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames(repo, version, names)))
    throw new Error(`${repo}: release assets differ from the distribution allowlist.`);
  if (assets.some(asset => asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 || asset.size > 2 * 1024 ** 3 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')))
    throw new Error(`${repo}: an asset has invalid size or checksum metadata.`);
  const fingerprint = assetFingerprint(assets);
  if (fingerprint !== expectedFingerprint) throw new Error(`${repo}: build receipt does not match draft assets.`);
  return release;
}

export class GitHubReleaseApi {
  constructor(token, fetcher = fetch) {
    if (!token) throw new Error('A release token is required.');
    this.token = token;
    this.fetcher = fetcher;
  }
  async request(route, options = {}) {
    const response = await this.fetcher(`${API}${route}`, {
      ...options, signal: AbortSignal.timeout(30000), headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...options.headers
      }
    });
    if (response.status === 404 && options.allowMissing) return null;
    if (!response.ok) throw new Error(`GitHub ${options.method ?? 'GET'} ${route}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async draft(repo, tag, fingerprint, allowPublished = false) {
    const release = await this.request(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    return validateRelease(repo, release, tag, fingerprint, allowPublished);
  }
  async downloadAsset(repo, asset, destination) {
    const url = `${API}/repos/${repo}/releases/assets/${asset.id}`;
    const response = await this.fetcher(url, {
      headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20 * 60 * 1000)
    });
    if (!response.ok || !response.body) throw new Error(`Could not download ${asset.name}: ${response.status}`);
    await mkdir(path.dirname(destination), { recursive: true });
    const digest = createHash('sha256');
    let size = 0;
    const hash = new Transform({ transform(chunk, encoding, done) {
      size += chunk.length;
      if (size > asset.size) return done(new Error('Asset exceeded its declared size.'));
      digest.update(chunk);
      done(null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(response.body), hash, createWriteStream(destination, { flags: 'wx' }));
      if ((await stat(destination)).size !== asset.size || `sha256:${digest.digest('hex')}` !== asset.digest)
        throw new Error('Downloaded installer checksum mismatch.');
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  }
  async publish(repo, release, versionCode) {
    if (!release.draft) return;
    const latest = await this.request(`/repos/${repo}/releases/latest`, { allowMissing: true });
    let makeLatest = true;
    if (latest) {
      try { makeLatest = releaseVersion(latest.tag_name).versionCode < versionCode; }
      catch { /* Initial releases may use a non-versioned tag. */ }
    }
    await this.request(`/repos/${repo}/releases/${release.id}`, { method: 'PATCH',
      body: JSON.stringify({ draft: false, make_latest: makeLatest ? 'true' : 'false' }) });
  }
}

async function main() {
  const [command, tag, clientFingerprint, dataFingerprint, destination] = process.argv.slice(2);
  const version = releaseVersion(tag);
  const api = new GitHubReleaseApi(process.env.GH_TOKEN);
  if (!/^[a-f0-9]{64}$/.test(clientFingerprint ?? '')) throw new Error('Invalid client fingerprint.');
  if (command === 'verify-installer') {
    if (!destination) throw new Error('Installer destination is required.');
    const release = await api.draft(CLIENT_REPO, tag, clientFingerprint);
    const asset = release.assets.find(item => item.name === 'NivelOmega-win-Setup.exe');
    await api.downloadAsset(CLIENT_REPO, asset, path.resolve(destination));
    console.log(`Verified installer for ${tag}.`);
  } else if (command === 'publish') {
    if (!/^[a-f0-9]{64}$/.test(dataFingerprint ?? '')) throw new Error('Invalid data fingerprint.');
    const client = await api.draft(CLIENT_REPO, tag, clientFingerprint, true);
    const data = await api.draft(DATA_REPO, tag, dataFingerprint, true);
    await api.publish(CLIENT_REPO, client, version.versionCode);
    await api.publish(DATA_REPO, data, version.versionCode);
    console.log(`Published ${tag} to both distribution repositories.`);
  } else throw new Error('Use verify-installer or publish.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
