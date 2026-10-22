const LocalFsProvider = require('./localFsProvider');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const stream = require('stream');

class S3Provider {
  constructor() {
    this.client = new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
    this.bucket = process.env.AWS_S3_BUCKET;
  }

  async upload(key, buffer, mimeType) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      })
    );
    return key;
  }

  async getUrl(key) {
    return `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  }

  async getStream(key) {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const response = await this.client.send(command);
    if (response.Body instanceof stream.Readable) {
      return response.Body;
    }
    throw new Error('S3 response body is not readable');
  }

  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

const providerName = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
let provider;
if (providerName === 's3') {
  provider = new S3Provider();
} else {
  provider = new LocalFsProvider();
}

module.exports = provider;
