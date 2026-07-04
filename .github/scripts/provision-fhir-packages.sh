#!/usr/bin/env bash
# Provision the public HL7 FHIR packages the validation/terminology tests read from the local FHIR
# cache (~/.fhir/packages). These are CC0/HL7-licensed conformance artifacts (StructureDefinitions,
# ValueSets, CodeSystems) — NOT licensed terminology content (SNOMED/LOINC/RxNorm), which is never
# downloaded here. Idempotent: skips a package that's already extracted.
set -euo pipefail

REGISTRY="${FHIR_PACKAGE_REGISTRY:-https://packages.simplifier.net}"
PKG_ROOT="${HOME}/.fhir/packages"
mkdir -p "$PKG_ROOT"

provision() {
  local name="$1" ver="$2"
  local dest="${PKG_ROOT}/${name}#${ver}"
  if [ -f "${dest}/package/package.json" ]; then
    echo "· ${name}#${ver} already present"; return 0
  fi
  echo "· fetching ${name}#${ver} from ${REGISTRY}"
  mkdir -p "$dest"
  curl -sSfL "${REGISTRY}/${name}/${ver}" -o /tmp/fhir-pkg.tgz
  tar -xzf /tmp/fhir-pkg.tgz -C "$dest"           # tarball top-level dir is `package/`
  test -f "${dest}/package/package.json" \
    || { echo "::error::${name}#${ver} did not extract as expected (no package/package.json)"; exit 1; }
}

provision hl7.fhir.r4.core 4.0.1
provision hl7.fhir.us.core  6.1.0
echo "provisioned FHIR packages:"; ls "$PKG_ROOT"
