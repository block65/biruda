"use strict";
exports.__esModule = true;
var lib_1 = require("../lib");
lib_1.s3.copyObject({
    Bucket: 'lol',
    Key: 'kek',
    CopySource: 'lols'
})
    .promise()
    .then(console.log);
