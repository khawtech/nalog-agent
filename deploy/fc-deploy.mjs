// ──────────────────────────────────────────────────────────────────────────
// Deploy NaLog Agent to Alibaba Cloud Function Compute 3.0 as a ZIP-based
// custom runtime (custom.debian10, bundled Node 20) — no container image / ACR.
//
// Flow:
//   1. Build Linux node_modules in the Node 20 Docker image (so native deps
//      like `tablestore` match FC's bundled custom-runtime Node 20 on Debian x86-64).
//   2. Assemble /code (src, public, scripts, deploy/bootstrap, package.json,
//      node_modules) and zip it.
//   3. base64 the zip into the FC CreateFunction/UpdateFunction `code.zipFile`.
//   4. Ensure an anonymous HTTP trigger.
//
// Run from the repo root:  node deploy/fc-deploy.mjs
// Reads runtime env from .env, and Alibaba credentials from the aliyun CLI
// default profile (~/.aliyun/config.json).
// ──────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const FC = require('@alicloud/fc20230330');
const { $OpenApiUtil } = require('@alicloud/openapi-core');
const $dara = require('@darabonba/typescript');

const REGION = process.env.FC_REGION || 'ap-southeast-7';
const FUNCTION_NAME = process.env.FUNCTION_NAME || 'nalog-agent';
const PORT = Number(process.env.FC_LISTEN_PORT || 9000);
const ACCOUNT_ID = process.env.ALIBABA_CLOUD_ACCOUNT_ID || '';
if (!ACCOUNT_ID) throw new Error('ALIBABA_CLOUD_ACCOUNT_ID env var is required');

const ENV_KEYS = [
  'NODE_ENV', 'DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL', 'MODEL_ROUTER', 'MODEL_CHAT',
  'MODEL_REASON', 'EMBEDDING_MODEL', 'EMBEDDING_DIM', 'MAX_TOKENS_PER_TURN', 'STORAGE_DRIVER',
  'VECTOR_DRIVER', 'TABLESTORE_ENDPOINT', 'TABLESTORE_INSTANCE', 'TABLESTORE_ACCESS_KEY_ID',
  'TABLESTORE_ACCESS_KEY_SECRET', 'DASHVECTOR_ENDPOINT', 'DASHVECTOR_API_KEY',
  'DASHVECTOR_COLLECTION', 'NALOG_API_URL', 'NALOG_AUTH_TOKEN', 'NALOG_USE_DEMO',
  'ALLOWED_ORIGINS', 'CHIRPSTACK_API_URL', 'CHIRPSTACK_API_TOKEN', 'REQUIRE_HUMAN_APPROVAL', 'AGENT_API_KEY',
];

function loadCreds() {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.aliyun', 'config.json'), 'utf8'));
  const profileName = process.env.ALIBABA_CLOUD_PROFILE || 'default';
  const p = cfg.profiles.find((x) => x.name === profileName);
  if (!p?.access_key_id || !p?.access_key_secret) {
    throw new Error(`No access_key in aliyun profile "${profileName}"`);
  }
  return { accessKeyId: p.access_key_id, accessKeySecret: p.access_key_secret };
}

function buildEnv() {
  const out = { NODE_ENV: 'production', DATA_DIR: '/tmp/data', PORT: String(PORT) };
  for (const k of ENV_KEYS) if (process.env[k]) out[k] = process.env[k];
  return out;
}

function makeClient() {
  const creds = loadCreds();
  return new FC.default(
    new $OpenApiUtil.Config({
      accessKeyId: creds.accessKeyId,
      accessKeySecret: creds.accessKeySecret,
      regionId: REGION,
      endpoint: `${ACCOUNT_ID}.${REGION}.fc.aliyuncs.com`,
      readTimeout: 300000,
      connectTimeout: 120000,
    }),
  );
}

async function functionExists(client) {
  try {
    await client.getFunction(FUNCTION_NAME, new FC.GetFunctionRequest({}));
    return true;
  } catch (err) {
    if (err.statusCode === 404 || /FunctionNotFound|does not exist/i.test(err.message || '')) return false;
    throw err;
  }
}

async function main() {
  const zipPath = process.env.FC_ZIP || join(process.cwd(), 'dist', 'nalog-agent-fc.zip');
  const zipB64 = readFileSync(zipPath, 'base64');
  console.log(`▶ Loaded ${zipPath} (${(zipB64.length / 1024 / 1024).toFixed(1)} MB base64)`);

  const client = makeClient();
  const runtime = new $dara.RuntimeOptions({ readTimeout: 300000, connectTimeout: 120000 });

  const code = new FC.InputCodeLocation({ zipFile: zipB64 });
  const customRuntimeConfig = new FC.CustomRuntimeConfig({
    command: ['/code/deploy/bootstrap'],
    port: PORT,
  });

  const exists = await functionExists(client);

  if (!exists) {
    const input = new FC.CreateFunctionInput({
      functionName: FUNCTION_NAME,
      runtime: 'custom.debian10',
      handler: 'index.handler', // unused by custom runtime, but required by the API
      cpu: 0.5,
      memorySize: 1024,
      diskSize: 512,
      timeout: 120,
      instanceConcurrency: 5,
      internetAccess: true,
      environmentVariables: buildEnv(),
      code,
      customRuntimeConfig,
    });
    console.log(`▶ Creating function ${FUNCTION_NAME} in ${REGION}`);
    await client.createFunctionWithOptions(
      new FC.CreateFunctionRequest({ body: input }), {}, runtime,
    );
  } else {
    const input = new FC.UpdateFunctionInput({
      runtime: 'custom.debian10',
      handler: 'index.handler',
      cpu: 0.5,
      memorySize: 1024,
      diskSize: 512,
      timeout: 120,
      instanceConcurrency: 5,
      internetAccess: true,
      environmentVariables: buildEnv(),
      code,
      customRuntimeConfig,
    });
    console.log(`▶ Updating function ${FUNCTION_NAME} in ${REGION}`);
    await client.updateFunctionWithOptions(
      FUNCTION_NAME,
      new FC.UpdateFunctionRequest({ body: input }), {}, runtime,
    );
  }

  // Ensure an anonymous HTTP trigger.
  let hasTrigger = false;
  try {
    await client.getTrigger(FUNCTION_NAME, 'http');
    hasTrigger = true;
  } catch (err) {
    if (!(err.statusCode === 404 || /TriggerNotFound/i.test(err.message || ''))) throw err;
  }
  if (!hasTrigger) {
    console.log('▶ Creating HTTP trigger');
    const trigger = new FC.CreateTriggerInput({
      triggerName: 'http',
      triggerType: 'http',
      triggerConfig: JSON.stringify({ authType: 'anonymous', methods: ['GET', 'POST', 'PUT', 'DELETE'] }),
    });
    await client.createTriggerWithOptions(
      FUNCTION_NAME,
      new FC.CreateTriggerRequest({ body: trigger }), {}, runtime,
    );
  } else {
    console.log('  (HTTP trigger already exists)');
  }

  const tr = await client.getTrigger(FUNCTION_NAME, 'http');
  const url = tr.body?.httpTrigger?.urlInternet || tr.body?.httpTrigger?.urlIntranet;
  console.log('✅ Deployed.');
  console.log(`   Trigger URL: ${url}`);
}

main().catch((err) => {
  console.error('Deploy failed:', err.message || err);
  if (err.data) console.error(JSON.stringify(err.data, null, 2));
  process.exit(1);
});
