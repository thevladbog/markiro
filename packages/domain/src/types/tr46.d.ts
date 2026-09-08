/** Typed subset used from the pinned, untyped tr46 6.0.0 package. */
declare module "tr46" {
  export function toASCII(
    domainName: string,
    options: {
      checkBidi: boolean;
      checkHyphens: boolean;
      checkJoiners: boolean;
      ignoreInvalidPunycode: boolean;
      transitionalProcessing: boolean;
      useSTD3ASCIIRules: boolean;
      verifyDNSLength: boolean;
    },
  ): string | null;
}
