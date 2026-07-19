const { createHash } = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

const MANIFEST_FILE = 'artifact-manifest.json';
const EXCLUDED_FILES = new Set([MANIFEST_FILE, 'trial.json']);

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function safeRelative(relative) {
  return typeof relative === 'string'
    && relative.length > 0
    && !path.isAbsolute(relative)
    && !relative.includes('\\')
    && relative.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

async function listArtifactFiles(root, directory = root) {
  const files = [];
  for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    const stat = await fsPromises.lstat(resolved);
    if (stat.isSymbolicLink()) throw new Error('Artifact tree contains a symbolic link');
    if (stat.isDirectory()) {
      files.push(...await listArtifactFiles(root, resolved));
      continue;
    }
    if (!stat.isFile() || stat.nlink > 1) {
      throw new Error('Artifact tree contains a non-regular or multiply-linked file');
    }
    const relative = path.relative(root, resolved).split(path.sep).join('/');
    if (!EXCLUDED_FILES.has(relative)) files.push({ relative, resolved, stat });
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

async function buildArtifactManifest(root) {
  const files = await listArtifactFiles(root);
  const entries = [];
  for (const file of files) {
    entries.push({
      path: file.relative,
      bytes: file.stat.size,
      sha256: await sha256File(file.resolved)
    });
  }
  return {
    schemaVersion: 1,
    algorithm: 'sha256',
    files: entries,
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0)
  };
}

async function verifyArtifactManifest(root, integrity) {
  if (
    integrity?.manifest !== MANIFEST_FILE
    || !/^[a-f0-9]{64}$/.test(integrity?.manifestSha256 ?? '')
  ) {
    throw new Error('Trial is missing a pinned artifact manifest');
  }
  const manifestFile = path.join(root, MANIFEST_FILE);
  const manifestStat = await fsPromises.lstat(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink > 1) {
    throw new Error('Artifact manifest must be a singly-linked regular file');
  }
  if (await sha256File(manifestFile) !== integrity.manifestSha256) {
    throw new Error('Artifact manifest digest mismatch');
  }
  const manifest = JSON.parse(await fsPromises.readFile(manifestFile, 'utf8'));
  if (
    manifest?.schemaVersion !== 1
    || manifest?.algorithm !== 'sha256'
    || !Array.isArray(manifest.files)
    || manifest.fileCount !== manifest.files.length
    || !Number.isSafeInteger(manifest.totalBytes)
    || manifest.totalBytes < 0
  ) {
    throw new Error('Artifact manifest has an invalid structure');
  }
  const actualFiles = await listArtifactFiles(root);
  if (actualFiles.length !== manifest.files.length) {
    throw new Error('Artifact manifest file set mismatch');
  }
  let totalBytes = 0;
  for (let index = 0; index < manifest.files.length; index++) {
    const expected = manifest.files[index];
    const actual = actualFiles[index];
    if (
      !safeRelative(expected?.path)
      || expected.path !== actual.relative
      || !Number.isSafeInteger(expected.bytes)
      || expected.bytes < 0
      || !/^[a-f0-9]{64}$/.test(expected.sha256 ?? '')
    ) {
      throw new Error(`Artifact manifest entry ${index} is invalid or out of order`);
    }
    if (actual.stat.size !== expected.bytes) {
      throw new Error(`Artifact size mismatch: ${expected.path}`);
    }
    if (await sha256File(actual.resolved) !== expected.sha256) {
      throw new Error(`Artifact digest mismatch: ${expected.path}`);
    }
    totalBytes += expected.bytes;
  }
  if (totalBytes !== manifest.totalBytes) throw new Error('Artifact manifest totalBytes mismatch');
  if (
    integrity.fileCount !== manifest.fileCount
    || integrity.totalBytes !== manifest.totalBytes
  ) {
    throw new Error('Trial artifact-integrity summary does not match its manifest');
  }
  return manifest;
}

module.exports = {
  MANIFEST_FILE,
  buildArtifactManifest,
  listArtifactFiles,
  sha256File,
  verifyArtifactManifest
};
