import { promises as fs } from 'node:fs';
import path from 'node:path';

const API_DIR = path.resolve('api');

async function collectFiles(dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relPath = path.join(prefix, entry.name);
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absPath, relPath));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

function toRouteKey(filePath) {
  const parsed = path.parse(filePath);
  const dir = parsed.dir ? parsed.dir.split(path.sep).join('/') : '';
  const base = parsed.name;
  return dir ? `${dir}/${base}` : base;
}

async function main() {
  try {
    await fs.access(API_DIR);
  } catch (error) {
    console.error('API directory not found:', API_DIR);
    process.exit(0);
    return;
  }

  const files = await collectFiles(API_DIR);
  const map = new Map();
  for (const file of files) {
    const key = toRouteKey(file);
    const existing = map.get(key);
    if (existing) {
      existing.push(file);
    } else {
      map.set(key, [file]);
    }
  }

  const duplicates = Array.from(map.entries()).filter(([, files]) => files.length > 1);

  if (duplicates.length) {
    console.error('Conflicting API routes detected:');
    for (const [key, files] of duplicates) {
      console.error(`  ${key}: ${files.join(', ')}`);
    }
    process.exit(1);
    return;
  }

  console.log('No conflicting API routes detected.');
}

main().catch((error) => {
  console.error('Failed to verify API routes:', error);
  process.exit(1);
});
