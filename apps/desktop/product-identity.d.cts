interface ProductIdentity {
  /** True when this artifact is Hermes Light (remote-only client). */
  light: boolean
  /** True for a Store-submission build (Windows Store packaging identity). */
  store: boolean
  /** True for a private Hermes Refocus side-by-side build (never a feed). */
  refocus: boolean
  /** Display name. e.g. "Hermes Light" */
  displayName: string
  /** OS-level app identity. e.g. "com.nousresearch.hermes-light" */
  appId: string
  /** app name in pascal case. e.g. "HermesLight" */
  appNamePascal: string
  /** Artifact prefix stays compatible with release archive consumers. */
  artifactNamePascal: string
  /** Windows GUI executable stem; not the payload CLI launcher path. */
  windowsExecutableName: string
  /** Exposed payload CLI command. */
  cliName: string
  /** OS-level app identity w/ org prefix. e.g. "NousResearch.HermesLight" */
  msixAppIdWithOrg: string
  /** MSIX Publisher string in the package Identity. Present only on refocus
   * builds: the provisional "CN=Refocus Development" for unsigned
   * candidates, the exact signing-cert Subject (HERMES_MSIX_PUBLISHER) for
   * signed builds. Official variants carry theirs out of band
   * (OUT_OF_STORE_PUBLISHER / storeMsix.publisher). */
  readonly msixPublisher?: string
  /** R2 identity token on channel builds; absent on legacy products. */
  readonly token?: string
  /** Channel subscription for channel builds; legacy electron-updater label otherwise. Stable tags:
   *  "latest" | "light"; canary tags: "canary" | "light-canary". Null
   *  for Store and commit builds (no release feed). */
  readonly channel: string | null
  /** Store-submission MSIX packaging identity. Present only when `store`. */
  storeMsix?: {
    identityName: string
    publisher: string
    publisherDisplayName: string
  }
}

declare const identity: ProductIdentity
export = identity
