import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const H1_CLOUD_NODE_KEYS = [
  'FI1',
  'ES1',
  'PL1',
  'CH1',
  'SE1',
  'NL1',
] as const;

export type H1CloudNodeKey = (typeof H1_CLOUD_NODE_KEYS)[number];

type H1CloudNodeConfig = {
  baseUrl: string;
  token: string;
  inboundId: string;
};

type H1InboundLink = {
  id: string;
  tag: string;
  protocol: string;
  network: string;
  security: string;
  port: number;
  link: string;
};

export type H1Inbound = {
  id: string;
  tag: string;
  protocol: string;
  network: string;
  security: string;
  port: number;
  enabled?: boolean;
  active?: boolean;
  status?: string | boolean;
};

export type H1Status = {
  ok: boolean;
  service?: string;
  version?: string;
  node_name?: string;
  domain?: string;
  transport?: {
    mode?: string;
  };
  egress?: {
    mode?: string;
  };
  reality?: {
    enabled?: boolean;
    public_host?: string;
    public_port?: string | number;
    sni?: string;
    dest?: string;
  };
  clients?: {
    total?: number;
    active?: number;
    expired?: number;
    banned?: number;
  };
};

export type H1Client = {
  name: string;
  uuid: string;
  status: string;
  expires_at: number;
  left_days: number;
  inbound_links: H1InboundLink[];
  sub_url: string;
  traffic_used_bytes: number;
  device_limit: number;
  devices_count: number;
  online: boolean;
};

@Injectable()
export class H1CloudService {
  private readonly nodes: Record<H1CloudNodeKey, H1CloudNodeConfig>;

  constructor(private readonly config: ConfigService) {
    this.nodes = Object.fromEntries(
      H1_CLOUD_NODE_KEYS.map((nodeKey) => [
        nodeKey,
        {
          baseUrl: (
            this.config.get<string>(`H1CLOUD_${nodeKey}_API_URL`) || ''
          ).replace(/\/+$/, ''),
          token: this.config.get<string>(`H1CLOUD_${nodeKey}_API_TOKEN`) || '',
          inboundId:
            this.config.get<string>(`H1CLOUD_${nodeKey}_INBOUND_ID`) || '',
        },
      ]),
    ) as Record<H1CloudNodeKey, H1CloudNodeConfig>;
  }

  isConfigured(nodeKey: H1CloudNodeKey): boolean {
    const node = this.nodes[nodeKey];

    return Boolean(node.baseUrl && node.token && node.inboundId);
  }

  getConfiguredNodeKeys(): H1CloudNodeKey[] {
    return H1_CLOUD_NODE_KEYS.filter((nodeKey) => this.isConfigured(nodeKey));
  }

  private getNode(nodeKey: H1CloudNodeKey): H1CloudNodeConfig {
    const node = this.nodes[nodeKey];

    if (!node?.baseUrl) {
      throw new Error(`H1Cloud ${nodeKey} API URL missing`);
    }

    if (!node.token) {
      throw new Error(`H1Cloud ${nodeKey} API token missing`);
    }

    return node;
  }

  private getInboundIds(
    nodeKey: H1CloudNodeKey,
    node: H1CloudNodeConfig,
  ): string[] {
    const extraInboundIds = (
      this.config.get<string>(`H1CLOUD_${nodeKey}_EXTRA_INBOUND_IDS`) || ''
    )
      .split(',')
      .map((inboundId) => inboundId.trim())
      .filter(Boolean);

    return [...new Set([node.inboundId, ...extraInboundIds])];
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    nodeKey: H1CloudNodeKey = 'FI1',
  ): Promise<T> {
    const node = this.getNode(nodeKey);

    const response = await fetch(`${node.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${node.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    const text = await response.text();

    let data: unknown;

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `H1Cloud ${nodeKey} invalid JSON: HTTP ${response.status}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `H1Cloud ${nodeKey} HTTP ${response.status}: ${JSON.stringify(data)}`,
      );
    }

    return data as T;
  }

  async status(nodeKey: H1CloudNodeKey = 'FI1'): Promise<H1Status> {
    return this.request<H1Status>('/api/status', {}, nodeKey);
  }

  async getClients(nodeKey: H1CloudNodeKey = 'FI1'): Promise<H1Client[]> {
    const result = await this.request<{
      ok: boolean;
      clients: H1Client[];
    }>('/api/clients', {}, nodeKey);

    return result.clients || [];
  }

  async getInbounds(nodeKey: H1CloudNodeKey = 'FI1') {
    return this.request<{
      ok: boolean;
      inbounds: H1Inbound[];
    }>('/api/inbounds', {}, nodeKey);
  }

  async getClientByName(
    name: string,
    nodeKey: H1CloudNodeKey = 'FI1',
  ): Promise<H1Client | null> {
    const clients = await this.getClients(nodeKey);

    return clients.find((client) => client.name === name) || null;
  }

  async createClient(
    params: {
      name: string;
      days: number;
      deviceLimit?: number;
    },
    nodeKey: H1CloudNodeKey = 'FI1',
  ): Promise<H1Client> {
    const node = this.getNode(nodeKey);

    if (!node.inboundId) {
      throw new Error(`H1Cloud ${nodeKey} inbound ID missing`);
    }

    const result = await this.request<{
      ok: boolean;
      client: H1Client;
    }>(
      '/api/create',
      {
        method: 'POST',
        body: JSON.stringify({
          name: params.name,
          days: params.days,
          device_limit: params.deviceLimit ?? 1,
          channels: [],
          inbound_ids: this.getInboundIds(nodeKey, node),
          wg: false,
        }),
      },
      nodeKey,
    );

    return result.client;
  }

  async extendClient(
    name: string,
    days: number,
    nodeKey: H1CloudNodeKey = 'FI1',
  ): Promise<H1Client> {
    const node = this.getNode(nodeKey);

    if (!node.inboundId) {
      throw new Error(`H1Cloud ${nodeKey} inbound ID missing`);
    }

    const result = await this.request<{
      ok: boolean;
      client: H1Client;
    }>(
      `/api/clients/${encodeURIComponent(name)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          traffic_limit_gb: 0,
          device_limit: 1,
          channels: [],
          inbound_ids: this.getInboundIds(nodeKey, node),
          wg: false,
          days,
        }),
      },
      nodeKey,
    );

    return result.client;
  }

  async deleteClient(
    name: string,
    nodeKey: H1CloudNodeKey = 'FI1',
  ): Promise<boolean> {
    await this.request(
      `/api/clients/${encodeURIComponent(name)}`,
      {
        method: 'DELETE',
      },
      nodeKey,
    );

    return true;
  }

  private nameForSubscription(subscriptionId: string) {
    return `sub_${subscriptionId}`;
  }

  getPrimaryLink(client: H1Client): string {
    const link = client.inbound_links?.[0]?.link;

    if (!link) {
      throw new Error(`H1Cloud client ${client.name} has no inbound link`);
    }

    return link;
  }

  async createForSubscription(
    subscriptionId: string,
    days: number,
    nodeKey: H1CloudNodeKey = 'FI1',
  ): Promise<H1Client> {
    const name = this.nameForSubscription(subscriptionId);

    const existing = await this.getClientByName(name, nodeKey);

    if (existing) {
      return existing;
    }

    return this.createClient(
      {
        name,
        days,
        deviceLimit: 1,
      },
      nodeKey,
    );
  }

  async extendForSubscription(
    subscriptionId: string,
    days: number,
    nodeKey: H1CloudNodeKey = 'FI1',
    createDays: number = days,
  ): Promise<H1Client> {
    const name = this.nameForSubscription(subscriptionId);

    const existing = await this.getClientByName(name, nodeKey);

    if (!existing) {
      return this.createClient(
        {
          name,
          days: createDays,
          deviceLimit: 1,
        },
        nodeKey,
      );
    }

    return this.extendClient(name, days, nodeKey);
  }

  async deleteForSubscription(
    subscriptionId: string,
    nodeKey: H1CloudNodeKey = 'FI1',
  ): Promise<boolean> {
    const name = this.nameForSubscription(subscriptionId);

    const existing = await this.getClientByName(name, nodeKey);

    if (!existing) {
      return true;
    }

    return this.deleteClient(name, nodeKey);
  }

  getConfiguredInboundId(nodeKey: H1CloudNodeKey = 'FI1') {
    return this.nodes[nodeKey].inboundId;
  }
}
