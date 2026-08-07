/**
 * R4 Core COMPOSITE search parameters the engine can actually serve (the codegen drops type
 * `composite` from the main registry). Listed explicitly — each entry's components use the
 * restricted expression grammar the indexer resolves (`prop`, `prop.as(Type)`), and the pair is
 * materialized at write time as index rows with **same-element** semantics:
 *   row.system = component-1 token (both `system|code` and bare `code` encodings)
 *   row.value  = component-2 value (quantity number / concept code / string / date instant)
 * so `Observation?code-value-quantity=8480-6$gt100` matches only when BOTH parts come from the
 * same (component) element — the property flat per-param rows cannot express.
 *
 * Composites NOT listed here stay unregistered → strict mode still rejects them honestly.
 */
import type { SearchParamDef } from "./r4-search-params.js";

const OBS = "Observation";
const quantity = (base: string): SearchParamDef => ({
  type: "composite", expression: base,
  components: [{ expression: "code", type: "token" }, { expression: "value.as(Quantity)", type: "quantity" }],
});
const concept = (base: string): SearchParamDef => ({
  type: "composite", expression: base,
  components: [{ expression: "code", type: "token" }, { expression: "value.as(CodeableConcept)", type: "token" }],
});

export const COMPOSITE_SEARCH_PARAMS: Record<string, Record<string, SearchParamDef>> = {
  Observation: {
    "code-value-quantity": quantity(OBS),
    "code-value-concept": concept(OBS),
    "code-value-date": {
      type: "composite", expression: OBS,
      components: [{ expression: "code", type: "token" }, { expression: "value.as(dateTime) | value.as(Period)", type: "date" }],
    },
    "code-value-string": {
      type: "composite", expression: OBS,
      components: [{ expression: "code", type: "token" }, { expression: "value.as(string)", type: "string" }],
    },
    "combo-code-value-quantity": quantity(`${OBS} | ${OBS}.component`),
    "combo-code-value-concept": concept(`${OBS} | ${OBS}.component`),
    "component-code-value-quantity": quantity(`${OBS}.component`),
    "component-code-value-concept": concept(`${OBS}.component`),
  },
};
