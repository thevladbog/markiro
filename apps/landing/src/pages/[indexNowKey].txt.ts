import { readIndexNowKey } from "../lib/site-config";

/**
 * IndexNow ownership proof: the key is served at `/{key}.txt` only when the
 * build was configured with PUBLIC_INDEXNOW_KEY. The key is public by protocol.
 */
export function getStaticPaths() {
  const key = readIndexNowKey({ PUBLIC_INDEXNOW_KEY: import.meta.env.PUBLIC_INDEXNOW_KEY });
  return key === null ? [] : [{ params: { indexNowKey: key }, props: { key } }];
}

export function GET({ props }: { props: { key: string } }): Response {
  return new Response(props.key, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
