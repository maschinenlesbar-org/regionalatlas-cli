import { test } from "node:test";
import assert from "node:assert/strict";
import { findLevel, resolveLevel, levelForTyp } from "../src/client/levels.js";
import { RegionalatlasValidationError } from "../src/client/errors.js";

test("friendly names and aliases map to the right typ", () => {
  assert.equal(resolveLevel("land").typ, 1);
  assert.equal(resolveLevel("bundesland").typ, 1);
  assert.equal(resolveLevel("laender").typ, 1);
  assert.equal(resolveLevel("regierungsbezirk").typ, 2);
  assert.equal(resolveLevel("rb").typ, 2);
  assert.equal(resolveLevel("kreis").typ, 3);
  assert.equal(resolveLevel("landkreis").typ, 3);
  assert.equal(resolveLevel("gemeinde").typ, 5);
  assert.equal(resolveLevel("gemeinden").typ, 5);
});

test("level matching is case-insensitive and trims", () => {
  assert.equal(resolveLevel("  LAND ").typ, 1);
  assert.equal(resolveLevel("Kreise").typ, 3);
});

test("an unknown level throws a typed validation error", () => {
  assert.equal(findLevel("planet"), undefined);
  assert.throws(() => resolveLevel("planet"), RegionalatlasValidationError);
  // typ=4 is not published, so it is not a resolvable level.
  assert.equal(levelForTyp(4), undefined);
});

test("levelForTyp maps a raw integer back to a level", () => {
  assert.equal(levelForTyp(1)?.name, "land");
  assert.equal(levelForTyp(5)?.name, "gemeinde");
});
