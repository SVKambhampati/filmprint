import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseRows } from "./csv.ts";

test("quoted fields with commas, quotes and newlines survive intact", () => {
  const text = [
    "Date,Name,Review",
    '2024-01-02,"Am I OK?","He said ""hello"", then left."',
    '2024-01-03,"Léon: The Professional","line one',
    'line two"',
  ].join("\n");
  const recs = parseCsv(text);
  assert.equal(recs.length, 2);
  assert.equal(recs[0]!.review, 'He said "hello", then left.');
  assert.equal(recs[1]!.name, "Léon: The Professional");
  assert.equal(recs[1]!.review, "line one\nline two");
});

test("CRLF line endings and a BOM are handled", () => {
  const recs = parseCsv('﻿Date,Name\r\n2024-01-02,Dune\r\n');
  assert.equal(recs.length, 1);
  assert.equal(recs[0]!.date, "2024-01-02");
  assert.equal(recs[0]!.name, "Dune");
});

test("headers are canonicalised so 'Watched Date' is reachable", () => {
  const recs = parseCsv("Watched  Date,LETTERBOXD URI\n2024-01-02,x");
  assert.equal(recs[0]!["watched date"], "2024-01-02");
  assert.equal(recs[0]!["letterboxd uri"], "x");
});

test("a trailing newline does not produce a phantom record", () => {
  assert.equal(parseCsv("Date,Name\n2024-01-02,Dune\n").length, 1);
  assert.equal(parseCsv("Date,Name\n").length, 0);
  assert.equal(parseCsv("").length, 0);
});

test("short rows fill missing trailing columns with empty strings", () => {
  const recs = parseCsv("Date,Name,Rating\n2024-01-02,Dune");
  assert.equal(recs[0]!.rating, "");
});

test("an empty quoted field is distinguishable from a missing one", () => {
  const rows = parseRows('a,"",c');
  assert.deepEqual(rows[0], ["a", "", "c"]);
});
