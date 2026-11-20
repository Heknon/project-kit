import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { type Env, env } from "@/lib/env";

const EXPIRES_IN_SECONDS = 300;

export const storageEnabled = Boolean(env.S3_BUCKET);

export function objectKey(prefix: string, ...parts: string[]): string {
  for (const part of parts) {
    if (part === "" || part.includes("/") || part === "." || part === "..") {
      throw new Error("Invalid key part");
    }
  }
  return prefix + parts.join("/");
}

export function stripPrefix(prefix: string, key: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function clientConfig(source: Env) {
  const credentials = source.S3_ROLE_ARN
    ? awsCredentialsProvider({ roleArn: source.S3_ROLE_ARN })
    : source.S3_ACCESS_KEY_ID && source.S3_SECRET_ACCESS_KEY
      ? { accessKeyId: source.S3_ACCESS_KEY_ID, secretAccessKey: source.S3_SECRET_ACCESS_KEY }
      : undefined;
  return {
    region: source.S3_REGION ?? "us-east-1",
    endpoint: source.S3_ENDPOINT,
    forcePathStyle: Boolean(source.S3_ENDPOINT),
    credentials,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  } as const;
}

let client: S3Client | undefined;

function s3(): { client: S3Client; bucket: string } {
  if (!env.S3_BUCKET) throw new Error("S3_BUCKET is not set");
  client ??= new S3Client(clientConfig(env));
  return { client, bucket: env.S3_BUCKET };
}

export function presignPut(parts: string[], contentType: string): Promise<string> {
  const { client, bucket } = s3();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey(env.S3_PREFIX, ...parts),
    ContentType: contentType,
  });
  return getSignedUrl(client, command, { expiresIn: EXPIRES_IN_SECONDS });
}

export function presignGet(parts: string[]): Promise<string> {
  const { client, bucket } = s3();
  const command = new GetObjectCommand({ Bucket: bucket, Key: objectKey(env.S3_PREFIX, ...parts) });
  return getSignedUrl(client, command, { expiresIn: EXPIRES_IN_SECONDS });
}

export async function list(parts: string[]): Promise<string[]> {
  const { client, bucket } = s3();
  const prefix = `${objectKey(env.S3_PREFIX, ...parts)}/`;
  const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return (result.Contents ?? []).flatMap((object) => (object.Key ? [stripPrefix(prefix, object.Key)] : []));
}
