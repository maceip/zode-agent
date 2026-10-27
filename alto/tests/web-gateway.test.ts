import type { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  controlSessionAllowed,
  controlSessionUrl,
  loopbackBindHost,
  requestAuthorityAllowed,
  reserveCommand,
  WEB_SECURITY_HEADERS,
  WebGateway,
  websocketAdmissionAllowed,
} from '../src/server/services/web-gateway.js'

describe('web gateway admission', () => {
  it('refuses every unauthenticated non-loopback bind target', () => {
    expect(loopbackBindHost('localhost')).toBe(true)
    expect(loopbackBindHost('127.0.0.1')).toBe(true)
    expect(loopbackBindHost('127.42.0.9')).toBe(true)
    expect(loopbackBindHost('::1')).toBe(true)
    expect(loopbackBindHost('::ffff:127.0.0.1')).toBe(true)
    expect(loopbackBindHost('0127.0.0.1')).toBe(false)
    expect(loopbackBindHost('0.0.0.0')).toBe(false)
    expect(loopbackBindHost('::')).toBe(false)
    expect(loopbackBindHost('192.168.1.10')).toBe(false)
    expect(loopbackBindHost('alto.example')).toBe(false)
    expect(() => new WebGateway({} as Context, {
      projectRoot: '/tmp/alto-test',
      controlSecret: 'test-control-secret',
      host: '0.0.0.0',
    })).toThrow('remote serving has no authentication')
  })

  it('requires the launch capability before disclosing the socket protocol', () => {
    const secret = 'owner-only-control-secret'

    expect(controlSessionAllowed(undefined, secret)).toBe(false)
    expect(controlSessionAllowed('Bearer wrong', secret)).toBe(false)
    expect(controlSessionAllowed(`Basic ${secret}`, secret)).toBe(false)
    expect(controlSessionAllowed(`Bearer ${secret}`, secret)).toBe(true)
  })

  it('passes the launch capability in a fragment rather than an HTTP request target', () => {
    const url = new URL(controlSessionUrl('http://127.0.0.1:4317', 'owner-only'))

    expect(url.origin).toBe('http://127.0.0.1:4317')
    expect(url.pathname).toBe('/')
    expect(url.search).toBe('')
    expect(url.hash).toBe('#alto-control=owner-only')
  })

  it('denies framing in both modern and legacy clients', () => {
    expect(WEB_SECURITY_HEADERS['Content-Security-Policy'])
      .toContain("frame-ancestors 'none'")
    expect(WEB_SECURITY_HEADERS['X-Frame-Options']).toBe('DENY')
    expect(WEB_SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer')
  })

  it('accepts loopback aliases only on the configured port', () => {
    expect(requestAuthorityAllowed('127.0.0.1:4317', '127.0.0.1', 4317)).toBe(true)
    expect(requestAuthorityAllowed('localhost:4317', '127.0.0.1', 4317)).toBe(true)
    expect(requestAuthorityAllowed('[::1]:4317', '127.0.0.1', 4317)).toBe(true)
    expect(requestAuthorityAllowed('attacker.example:4317', '127.0.0.1', 4317)).toBe(false)
    expect(requestAuthorityAllowed('127.0.0.1:9000', '127.0.0.1', 4317)).toBe(false)
    expect(requestAuthorityAllowed('127.0.0.1:4317/path', '127.0.0.1', 4317)).toBe(false)
    expect(requestAuthorityAllowed('user@127.0.0.1:4317', '127.0.0.1', 4317)).toBe(false)
  })

  it('requires a same-origin request with the current socket protocol', () => {
    const protocol = 'alto.secret'
    expect(websocketAdmissionAllowed(
      'http://127.0.0.1:4317',
      '127.0.0.1:4317',
      protocol,
      protocol,
      '127.0.0.1',
      4317,
    )).toBe(true)
    expect(websocketAdmissionAllowed(
      'https://untrusted.example',
      '127.0.0.1:4317',
      protocol,
      protocol,
      '127.0.0.1',
      4317,
    )).toBe(false)
    expect(websocketAdmissionAllowed(
      'http://127.0.0.1:4317',
      '127.0.0.1:4317',
      'alto.wrong',
      protocol,
      '127.0.0.1',
      4317,
    )).toBe(false)
    expect(websocketAdmissionAllowed(
      undefined,
      '127.0.0.1:4317',
      protocol,
      protocol,
      '127.0.0.1',
      4317,
    )).toBe(false)
    expect(websocketAdmissionAllowed(
      'http://127.0.0.1:4317/path',
      '127.0.0.1:4317',
      protocol,
      protocol,
      '127.0.0.1',
      4317,
    )).toBe(false)
  })

  it('does not release the original reservation when a duplicate is rejected', () => {
    const commands = new Set<string>()
    const release = reserveCommand(commands, 'request-1')

    expect(() => reserveCommand(commands, 'request-1')).toThrow('duplicate requestId')
    expect(commands.has('request-1')).toBe(true)

    release()
    expect(commands.has('request-1')).toBe(false)
  })

  it('enforces the in-flight command limit', () => {
    const commands = new Set(['request-1'])

    expect(() => reserveCommand(commands, 'request-2', 1)).toThrow('too many in-flight')
    expect(commands).toEqual(new Set(['request-1']))
  })
})
