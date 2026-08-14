import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type H1InboundLink = {
  id: string;
  tag: string;
  protocol: string;
  network: string;
  security: string;
  port: number;
  link: string;
};

type H1Client = {
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
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly inboundId: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = (
      this.config.get<string>('H1CLOUD_FI1_API_URL') || ''
    ).replace(/\/+$/, '');

    this.token =
      this.config.get<string>('H1CLOUD_FI1_API_TOKEN') || '';

    this.inboundId =
      this.config.get<string>('H1CLOUD_FI1_INBOUND_ID') || '';
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new Error('H1Cloud API URL missing');
    }

    if (!this.token) {
      throw new Error('H1Cloud API token missing');
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
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
        `H1Cloud invalid JSON: HTTP ${response.status}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `H1Cloud HTTP ${response.status}: ${JSON.stringify(data)}`,
      );
    }

    return data as T;
  }

  async status() {
    return this.request<{ ok: boolean }>('/api/status');
  }

  async getClients(): Promise<H1Client[]> {
    const result = await this.request<{
      ok: boolean;
      clients: H1Client[];
    }>('/api/clients');

    return result.clients || [];
  }

  async getInbounds() {
    return this.request<{
      ok: boolean;
      inbounds: unknown[];
    }>('/api/inbounds');
  }

  async getClientByName(
    name: string,
  ): Promise<H1Client | null> {
    const clients = await this.getClients();

    return clients.find((client) => client.name === name) || null;
  }

  async createClient(params: {
    name: string;
    days: number;
    deviceLimit?: number;
  }): Promise<H1Client> {
    if (!this.inboundId) {
      throw new Error('H1Cloud inbound ID missing');
    }

    const result = await this.request<{
      ok: boolean;
      client: H1Client;
    }>('/api/create', {
      method: 'POST',
      body: JSON.stringify({
        name: params.name,
        days: params.days,
        device_limit: params.deviceLimit ?? 1,
        channels: [],
        inbound_ids: [this.inboundId],
        wg: false,
      }),
    });

    return result.client;
  }

  async extendClient(
    name: string,
    days: number,
  ): Promise<H1Client> {
    const result = await this.request<{
      ok: boolean;
      client: H1Client;
    }>(`/api/clients/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        traffic_limit_gb: 0,
        device_limit: 1,
        channels: [],
        inbound_ids: [this.inboundId],
        wg: false,
        days,
      }),
    });

    return result.client;
  }

  async deleteClient(name: string): Promise<boolean> {
    await this.request(
      `/api/clients/${encodeURIComponent(name)}`,
      {
        method: 'DELETE',
      },
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
  ): Promise<H1Client> {
    const name = this.nameForSubscription(subscriptionId);

    const existing = await this.getClientByName(name);

    if (existing) {
      return existing;
    }

    return this.createClient({
      name,
      days,
      deviceLimit: 1,
    });
  }

  async extendForSubscription(
    subscriptionId: string,
    days: number,
  ): Promise<H1Client> {
    const name = this.nameForSubscription(subscriptionId);

    const existing = await this.getClientByName(name);

    if (!existing) {
      return this.createClient({
        name,
        days,
        deviceLimit: 1,
      });
    }

    return this.extendClient(name, days);
  }

  async deleteForSubscription(
    subscriptionId: string,
  ): Promise<boolean> {
    const name = this.nameForSubscription(subscriptionId);

    const existing = await this.getClientByName(name);

    if (!existing) {
      return true;
    }

    return this.deleteClient(name);
  }

  getConfiguredInboundId() {
    return this.inboundId;
  }
}
