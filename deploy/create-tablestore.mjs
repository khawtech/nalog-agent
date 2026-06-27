// One-off: create a Tablestore instance via the management OpenAPI.
// Uses credentials from the default aliyun CLI profile (~/.aliyun/config.json).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const $Tablestore20201209 = require('@alicloud/tablestore20201209');
const $OpenApi = require('@alicloud/openapi-client');

const REGION = process.env.OTS_REGION || 'ap-southeast-7';
const INSTANCE = process.env.TABLESTORE_INSTANCE || 'nalog-agent';

function loadProfile() {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.aliyun', 'config.json'), 'utf8'));
  const p = cfg.profiles.find((x) => x.name === (process.env.ALIBABA_CLOUD_PROFILE || 'default'));
  if (!p?.access_key_id || !p?.access_key_secret) {
    throw new Error('No access_key_id/secret in aliyun default profile');
  }
  return { accessKeyId: p.access_key_id, accessKeySecret: p.access_key_secret };
}

async function main() {
  const creds = loadProfile();
  const client = new $Tablestore20201209.default(
    new $OpenApi.Config({
      accessKeyId: creds.accessKeyId,
      accessKeySecret: creds.accessKeySecret,
      regionId: REGION,
      endpoint: `tablestore.${REGION}.aliyuncs.com`,
    }),
  );

  const req = new $Tablestore20201209.CreateInstanceRequest({
    instanceName: INSTANCE,
    clusterType: 'SSD',
    instanceDescription: 'NaLog Agent memory (Bangkok)',
  });

  try {
    const res = await client.createInstance(req);
    console.log(JSON.stringify(res.body ?? res, null, 2));
  } catch (err) {
    const msg = err.message || String(err);
    if (/already exist|InstanceName.*used/i.test(msg)) {
      console.log(`Instance "${INSTANCE}" already exists in ${REGION}`);
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
