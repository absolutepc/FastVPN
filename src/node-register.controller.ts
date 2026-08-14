import { NodeTunnelService } from './node-tunnel.service';
import {
  Body,
  Controller,
  Post,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma/prisma.service';
import { NodeType } from '@prisma/client';

type RegisterNodeBody = {
  token: string;
  name: string;
  host: string;
  type: 'STANDARD' | 'PREMIUM';

  port?: number;
  maxUsers?: number;

  publicKey: string;
  shortId: string;
  sni: string;

  inboundTag?: string;
  fingerprint?: string;
};

@Controller('node-register')
export class NodeRegisterController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tunnel: NodeTunnelService,
  ) {}

  @Post()
  async register(@Body() body: RegisterNodeBody) {
    const expected =
      this.config.get<string>('NODE_REGISTER_TOKEN');

    if (!expected || body.token !== expected) {
      throw new UnauthorizedException();
    }

    if (
      !body.name ||
      !body.host ||
      !body.publicKey ||
      !body.shortId ||
      !body.sni
    ) {
      throw new BadRequestException(
        'Missing required node parameters',
      );
    }

    if (
      body.type !== 'STANDARD' &&
      body.type !== 'PREMIUM'
    ) {
      throw new BadRequestException(
        'Invalid node type',
      );
    }

    const existing = await this.prisma.node.findFirst({
      where: {
        host: body.host,
        port: body.port ?? 443,
      },
    });

    if (existing) {
      const updated = await this.prisma.node.update({
        where: {
          id: existing.id,
        },
        data: {
          name: body.name,
          type: body.type as NodeType,
          maxUsers: body.maxUsers ?? 50,
          publicKey: body.publicKey,
          shortId: body.shortId,
          sni: body.sni,
          inboundTag:
            body.inboundTag ?? 'vless-reality',
          fingerprint:
            body.fingerprint ?? 'chrome',
          isActive: false,
        },
      });

      const tunnel = await this.tunnel.setupTunnel(updated.id);

      return {
        ok: true,
        action: 'updated',
        nodeId: updated.id,
	tunnel,
      };
    }

    const node = await this.prisma.node.create({
      data: {
        name: body.name,
        host: body.host,
        port: body.port ?? 443,

        // Активируем только после создания SSH tunnel
        apiHost: null,
        apiPort: 10085,

        inboundTag:
          body.inboundTag ?? 'vless-reality',

        type: body.type as NodeType,
        maxUsers: body.maxUsers ?? 50,

        publicKey: body.publicKey,
        shortId: body.shortId,
        sni: body.sni,
        fingerprint:
          body.fingerprint ?? 'chrome',

        // ВАЖНО:
        // новая нода не попадёт пользователям,
        // пока backend не проверит Xray API
        isActive: false,
      },
    });

    const tunnel = await this.tunnel.setupTunnel(node.id);

    return {
      ok: true,
      action: 'created',
      nodeId: node.id,
      tunnel,
    };
  }
}
