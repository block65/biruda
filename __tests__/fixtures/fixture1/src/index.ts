import { s3 } from '../lib/index.js';

s3.copyObject({
  Bucket: 'lol',
  Key: 'kek',
  CopySource: 'lols',
})
  .promise()
  .then(console.log);
