import test from "node:test";
import assert from "node:assert/strict";
import { authorityPrefix, checkAuthority } from "../src/authority.js";

// Cases from the UCP specification's Authority Binding table.
const cases = [
  ["dev.ucp.shopping.checkout", "https://ucp.dev/schemas/checkout.json", true],
  ["dev.ucp.shopping.checkout", "https://shopping.ucp.dev/x.json", true],
  ["com.example.payments.installments", "https://example.com/i.json", true],
  ["com.example.pay", "https://pay.example.com/x.json", true],
  ["com.example.pay", "https://example.com/x.json", true],
  ["com.example.pay", "https://evil.example/x.json", false],
  ["dev.ucp.shopping.checkout", "https://evil.example/x.json", false],
  ["com.examplecorp.pay", "https://example.com/x.json", false],
  ["com.example.pay", "https://cdn.example.com/x.json", false],
];

for (const [name, url, expected] of cases) {
  test(`authority: ${name} <- ${url}`, () => {
    assert.equal(checkAuthority(name, url).ok, expected);
  });
}

test("authority: rejects userinfo, http, IP literals and single labels", () => {
  assert.equal(
    checkAuthority("dev.ucp.shopping.checkout", "https://ucp.dev@evil.example/x.json").ok,
    false,
  );
  assert.equal(
    checkAuthority("dev.ucp.shopping.checkout", "http://ucp.dev/x.json").ok,
    false,
  );
  assert.equal(
    checkAuthority("dev.ucp.shopping.checkout", "https://203.0.113.10/x.json").ok,
    false,
  );
  assert.equal(
    checkAuthority("dev.ucp.shopping.checkout", "https://localhost/x.json").ok,
    false,
  );
});

test("authority: does not require a matching port", () => {
  assert.equal(
    checkAuthority("com.example.pay", "https://pay.example.com:8443/x.json").ok,
    true,
  );
});

test("authorityPrefix reverses host labels", () => {
  assert.equal(authorityPrefix("Shop.Example.COM."), "com.example.shop");
});
