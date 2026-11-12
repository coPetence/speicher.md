import type { Request } from 'express';

import { secureCookies } from '../../src/common/secure-cookies';

function request(headers: Record<string, string> = {}, secure = false): Request {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return { secure, get: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
}

afterEach(() => {
  delete process.env.SPEICHER_PUBLIC_URL;
  delete process.env.SPEICHER_INSECURE_COOKIES;
});

describe('the Secure flag of a cookie', () => {
  it('is left off for plain HTTP with no sign of HTTPS', () => {
    expect(secureCookies(request())).toBe(false);
    expect(secureCookies(request({ 'X-Forwarded-Proto': 'http' }))).toBe(false);
    expect(secureCookies(request({ Forwarded: 'for=192.0.2.1;proto=http' }))).toBe(false);
    expect(secureCookies(request({ Referer: 'http://192.168.1.10:32168/' }))).toBe(false);
  });

  it('is set when Express takes the request for HTTPS', () => {
    expect(secureCookies(request({}, true))).toBe(true);
  });

  it('is set when the public URL is HTTPS', () => {
    process.env.SPEICHER_PUBLIC_URL = 'https://docs.example.com';
    expect(secureCookies(request())).toBe(true);
  });

  it('believes X-Forwarded-Proto from a proxy Express does not trust, in any position and case', () => {
    expect(secureCookies(request({ 'X-Forwarded-Proto': 'https' }))).toBe(true);
    expect(secureCookies(request({ 'X-Forwarded-Proto': 'http, https' }))).toBe(true);
    expect(secureCookies(request({ 'X-Forwarded-Proto': 'HTTPS' }))).toBe(true);
  });

  it('reads the protocol of the Forwarded header, quoted or not', () => {
    expect(secureCookies(request({ Forwarded: 'for=192.0.2.1;proto=https' }))).toBe(true);
    expect(secureCookies(request({ Forwarded: 'proto="https";host=docs.example.com' }))).toBe(true);
    expect(secureCookies(request({ Forwarded: 'for=192.0.2.1, for=10.0.0.1;proto=https' }))).toBe(
      true,
    );
    expect(secureCookies(request({ Forwarded: 'host=proto-https.example' }))).toBe(false);
  });

  it('is set when a proxy sends X-Forwarded-Ssl', () => {
    expect(secureCookies(request({ 'X-Forwarded-Ssl': 'on' }))).toBe(true);
  });

  it('is set when the browser names an HTTPS page as the origin or referrer', () => {
    expect(secureCookies(request({ Origin: 'https://docs.example.com' }))).toBe(true);
    expect(secureCookies(request({ Referer: 'https://docs.example.com/handbook' }))).toBe(true);
    expect(secureCookies(request({ Origin: 'null' }))).toBe(false);
  });

  it('stays off with SPEICHER_INSECURE_COOKIES, whatever the request says', () => {
    process.env.SPEICHER_INSECURE_COOKIES = 'true';
    process.env.SPEICHER_PUBLIC_URL = 'https://docs.example.com';
    expect(
      secureCookies(
        request({ 'X-Forwarded-Proto': 'https', Origin: 'https://docs.example.com' }, true),
      ),
    ).toBe(false);
  });
});
