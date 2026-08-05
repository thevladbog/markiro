import { readFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

const artifactPattern = /(?:\.tfstate(?:\.|$)|\.tfplan$|(?:^|\/)backend\.hcl$)/;
const literalCredentialPattern =
  /^\s*(?:access_key|secret_key|token)\s*=\s*(?:"[^"\r\n$<>]+"|'[^'\r\n$<>]+')(?:\s*(?:#|\/\/).*)?\s*$/im;
const structuredCredentialPattern =
  /(?:^|[{,]\s*)["']?(?:access_key|secret_key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|YC_TOKEN)["']?\s*:\s*(?:"[^"\r\n$<>]+"|'[^'\r\n$<>]+')(?=\s*(?:[,}#]|\/\/|$))/im;
const environmentCredentialPattern =
  /^\s*(?:export\s+)?(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|YC_TOKEN)\s*=\s*(?:"[^"\r\n$<>]+"|'[^'\r\n$<>]+'|(?![$<])[^#\s]+)(?:\s*#.*)?\s*$/im;
const nonblankSecretDefaultPattern =
  /variable\s+"(?:token|access_key|secret_key|password)"\s*{[^}]*default\s*=\s*["'][^"'\s]+["']/is;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function containsBinaryControlBytes(contents) {
  return contents.some(
    (byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f,
  );
}

export async function scanRepositoryLeaks(repositoryRoot, candidateFiles) {
  const violations = [];

  for (const relativePath of candidateFiles) {
    if (artifactPattern.test(relativePath)) {
      violations.push({ relativePath, reason: "forbidden Terraform artifact" });
      continue;
    }

    const encodedContents = await readFile(path.join(repositoryRoot, relativePath));
    let contents;

    try {
      contents = utf8Decoder.decode(encodedContents);
    } catch {
      violations.push({ relativePath, reason: "binary or invalid UTF-8 candidate" });
      continue;
    }

    if (containsBinaryControlBytes(encodedContents)) {
      violations.push({ relativePath, reason: "binary or invalid UTF-8 candidate" });
      continue;
    }

    if (
      literalCredentialPattern.test(contents) ||
      structuredCredentialPattern.test(contents) ||
      environmentCredentialPattern.test(contents)
    ) {
      violations.push({ relativePath, reason: "literal credential material" });
    }
    if (nonblankSecretDefaultPattern.test(contents)) {
      violations.push({ relativePath, reason: "nonblank secret variable default" });
    }
  }

  return violations;
}
