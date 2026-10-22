const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const stat = promisify(fs.stat);

class LocalFsProvider {
  constructor() {
    this.basePath = path.resolve(__dirname, '../../uploads');
    this.legacyBasePath = path.resolve(process.cwd(), 'backend/uploads');
  }

  async ensureBasePath() {
    try {
      await stat(this.basePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await mkdir(this.basePath, { recursive: true });
      } else {
        throw error;
      }
    }
  }

  async upload(key, buffer) {
    await this.ensureBasePath();
    const filePath = path.join(this.basePath, key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    return filePath;
  }

  getPath(key) {
    const primaryPath = path.join(this.basePath, key);
    const legacyPath = path.join(this.legacyBasePath, key);

    if (fs.existsSync(primaryPath)) {
      return primaryPath;
    }

    if (fs.existsSync(legacyPath)) {
      return legacyPath;
    }

    return primaryPath;
  }

  getStream(key) {
    return fs.createReadStream(this.getPath(key));
  }

  async delete(key) {
    const filePath = this.getPath(key);
    await fs.promises.unlink(filePath);
  }
}

module.exports = LocalFsProvider;
