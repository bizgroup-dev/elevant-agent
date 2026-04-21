/**
 * Elevant Monitoring Agent — SNMP Poller
 *
 * Polls network devices via SNMP for basic health metrics.
 * Covers Fortinet firewalls, legacy switches, and other SNMP-capable devices.
 *
 * Uses raw UDP SNMP v2c GET requests (no npm dependencies).
 */

import { createSocket } from 'dgram';
import type { AgentConfig, DeviceSnapshot } from './types';

// Standard OIDs
const OID = {
  sysName: '1.3.6.1.2.1.1.5.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysDescr: '1.3.6.1.2.1.1.1.0',
  // Interface count
  ifNumber: '1.3.6.1.2.1.2.1.0',
};

interface SnmpResult {
  oid: string;
  value: string | number;
  type: string;
}

/**
 * Encode an OID into BER format
 */
function encodeOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const encoded: number[] = [];

  // First two components encoded as 40*x + y
  encoded.push(40 * parts[0] + parts[1]);

  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    if (val < 128) {
      encoded.push(val);
    } else {
      const bytes: number[] = [];
      bytes.unshift(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        bytes.unshift((val & 0x7f) | 0x80);
        val >>= 7;
      }
      encoded.push(...bytes);
    }
  }

  return Buffer.from([0x06, encoded.length, ...encoded]);
}

/**
 * Build an SNMPv2c GET request packet
 */
function buildGetRequest(community: string, oid: string, requestId: number): Buffer {
  const communityBuf = Buffer.from(community, 'ascii');
  const encodedOid = encodeOid(oid);

  // Null value
  const nullValue = Buffer.from([0x05, 0x00]);

  // VarBind: SEQUENCE { OID, NULL }
  const varBind = Buffer.concat([encodedOid, nullValue]);
  const varBindSeq = Buffer.concat([Buffer.from([0x30, varBind.length]), varBind]);

  // VarBindList: SEQUENCE { VarBind }
  const varBindList = Buffer.concat([Buffer.from([0x30, varBindSeq.length]), varBindSeq]);

  // Request ID (integer)
  const reqIdBuf = Buffer.alloc(6);
  reqIdBuf[0] = 0x02; // INTEGER
  reqIdBuf[1] = 0x04;
  reqIdBuf.writeInt32BE(requestId, 2);

  // Error status and index (both 0)
  const errorStatus = Buffer.from([0x02, 0x01, 0x00]);
  const errorIndex = Buffer.from([0x02, 0x01, 0x00]);

  // GetRequest PDU (0xa0)
  const pduContent = Buffer.concat([reqIdBuf, errorStatus, errorIndex, varBindList]);
  const pdu = Buffer.concat([Buffer.from([0xa0, pduContent.length]), pduContent]);

  // Version (SNMPv2c = 1)
  const version = Buffer.from([0x02, 0x01, 0x01]);

  // Community string
  const communityTlv = Buffer.concat([Buffer.from([0x04, communityBuf.length]), communityBuf]);

  // Message SEQUENCE
  const messageContent = Buffer.concat([version, communityTlv, pdu]);
  const message = Buffer.concat([Buffer.from([0x30, messageContent.length]), messageContent]);

  return message;
}

/**
 * Parse a simple SNMP response value (basic types only)
 */
function parseSnmpResponse(buf: Buffer): { value: string | number; type: string } | null {
  try {
    // Walk through the BER structure to find the value
    // This is a simplified parser for common response types
    let pos = 0;

    // Skip outer SEQUENCE
    if (buf[pos] !== 0x30) return null;
    pos += 2; // tag + length

    // Skip version
    if (buf[pos] === 0x02) pos += 2 + buf[pos + 1];

    // Skip community
    if (buf[pos] === 0x04) pos += 2 + buf[pos + 1];

    // GetResponse PDU (0xa2)
    if (buf[pos] !== 0xa2) return null;
    pos += 2;

    // Skip request ID
    if (buf[pos] === 0x02) pos += 2 + buf[pos + 1];

    // Error status
    if (buf[pos] === 0x02) {
      const errLen = buf[pos + 1];
      const errVal = buf[pos + 2];
      if (errVal !== 0) return null; // SNMP error
      pos += 2 + errLen;
    }

    // Skip error index
    if (buf[pos] === 0x02) pos += 2 + buf[pos + 1];

    // VarBindList SEQUENCE
    if (buf[pos] === 0x30) pos += 2;

    // VarBind SEQUENCE
    if (buf[pos] === 0x30) pos += 2;

    // Skip OID
    if (buf[pos] === 0x06) pos += 2 + buf[pos + 1];

    // Value
    const valueTag = buf[pos];
    const valueLen = buf[pos + 1];
    const valueData = buf.subarray(pos + 2, pos + 2 + valueLen);

    switch (valueTag) {
      case 0x02: // INTEGER
        if (valueLen <= 4) {
          let val = 0;
          for (let i = 0; i < valueLen; i++) {
            val = (val << 8) | valueData[i];
          }
          return { value: val, type: 'integer' };
        }
        return { value: valueData.toString('hex'), type: 'integer' };
      case 0x04: // OCTET STRING
        return { value: valueData.toString('utf8'), type: 'string' };
      case 0x41: // Counter32
      case 0x42: // Gauge32
      case 0x43: // TimeTicks
        let val = 0;
        for (let i = 0; i < valueLen; i++) {
          val = (val << 8) | valueData[i];
        }
        return { value: val, type: valueTag === 0x43 ? 'timeticks' : 'counter' };
      case 0x40: // IpAddress
        return { value: Array.from(valueData).join('.'), type: 'ipaddress' };
      default:
        return { value: valueData.toString('hex'), type: `unknown(0x${valueTag.toString(16)})` };
    }
  } catch {
    return null;
  }
}

/**
 * Send an SNMP GET and wait for response
 */
function snmpGet(host: string, community: string, oid: string, timeoutMs = 5000): Promise<SnmpResult | null> {
  return new Promise((resolve) => {
    const requestId = Math.floor(Math.random() * 0x7fffffff);
    const packet = buildGetRequest(community, oid, requestId);
    const socket = createSocket('udp4');
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.close();
        resolve(null);
      }
    }, timeoutMs);

    socket.on('message', (msg) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        socket.close();
        const result = parseSnmpResponse(msg);
        resolve(result ? { oid, ...result } : null);
      }
    });

    socket.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        socket.close();
        resolve(null);
      }
    });

    socket.send(packet, 161, host);
  });
}

export class SnmpPoller {
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  async poll(): Promise<DeviceSnapshot[]> {
    if (!this.config.features.snmp || !this.config.snmp?.targets?.length) {
      return [];
    }

    const snapshots: DeviceSnapshot[] = [];

    for (const target of this.config.snmp.targets) {
      try {
        const [sysName, sysUpTime, sysDescr] = await Promise.all([
          snmpGet(target.host, target.community, OID.sysName),
          snmpGet(target.host, target.community, OID.sysUpTime),
          snmpGet(target.host, target.community, OID.sysDescr),
        ]);

        const isOnline = sysUpTime !== null;
        const uptimeSeconds = sysUpTime?.type === 'timeticks'
          ? Math.floor((sysUpTime.value as number) / 100)
          : undefined;

        snapshots.push({
          id: `snmp-${target.host}`,
          name: target.name || (sysName?.value as string) || target.host,
          model: (sysDescr?.value as string)?.split('\n')[0]?.substring(0, 100) || target.type,
          type: target.type,
          state: isOnline ? 'online' : 'offline',
          ip: target.host,
          uptime: uptimeSeconds,
          extra: {
            product: 'snmp',
            community: target.community,
            sysDescr: sysDescr?.value,
          },
        });

        if (isOnline) {
          console.log(`[snmp] ${target.name}: online, uptime ${uptimeSeconds ? Math.floor(uptimeSeconds / 86400) + 'd' : 'unknown'}`);
        } else {
          console.log(`[snmp] ${target.name}: OFFLINE (no SNMP response)`);
        }
      } catch (err) {
        console.error(`[snmp] ${target.name} poll failed:`, err);
        snapshots.push({
          id: `snmp-${target.host}`,
          name: target.name,
          model: target.type,
          type: target.type,
          state: 'offline',
          ip: target.host,
          extra: { product: 'snmp', error: String(err) },
        });
      }
    }

    return snapshots;
  }
}
