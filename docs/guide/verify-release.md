# Verify a release

Every [GitHub Release](https://github.com/mhidalgo-lab/relic-bridge/releases) of relic-bridge carries:

| Asset | What it is |
| --- | --- |
| `relic-bridge-<v>.tgz` | The npm tarball, byte for byte what is published on npm. |
| `relic-bridge-<v>.cdx.json` | CycloneDX SBOM of the production dependencies. |
| `SHA256SUMS` | Checksums of the files above. |
| `relic-bridge-<v>.intoto.jsonl` | Sigstore bundle of the build provenance attestation covering the three files above (releases after 0.9.0). |

The attestation is created by the release workflow (`.github/workflows/release.yml`) with GitHub OIDC and Sigstore.
It states which repository, workflow and commit built the files.

```bash
V=0.9.0   # the release you downloaded
gh release download "v$V" -R mhidalgo-lab/relic-bridge
sha256sum -c SHA256SUMS
gh attestation verify "relic-bridge-$V.tgz" -R mhidalgo-lab/relic-bridge
```

`gh attestation verify` fetches the attestation from GitHub. To verify offline with the downloaded bundle (a release
that has the `.intoto.jsonl` asset):

```bash
gh attestation verify "relic-bridge-$V.tgz" -R mhidalgo-lab/relic-bridge \
  --bundle "relic-bridge-$V.intoto.jsonl"
```

Releases before the `.intoto.jsonl` asset existed have the same attestation on GitHub, so the first command works for
them too. The npm package carries its own npm provenance: `npm audit signatures`. For the Docker image see
[self-hosting](self-hosting.md#docker).
