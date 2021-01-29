import { s3 } from '../lib';

s3.copyObject({
  Bucket: 'lol',
  Key: 'kek',
  CopySource: 'lols',
})
  .promise()
  .then(console.log);
