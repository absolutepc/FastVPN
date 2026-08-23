import { NodeTunnelService } from './node-tunnel.service';
import {
  Body,
  Controller,
  Post,
  Headers,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma/prisma.service';
import { NodeType } from '@prisma/client';
import { isIP } from 'net';
import { timingSafeEqual } from 'crypto';

type RegisterNodeBody = {
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

  private validateName(name: string) {
    if (
      typeof name !== 'string' ||
      name.length < 1 ||
      name.length > 64 ||
      !/^[a-zA-Z0-9 _.-]+$/.test(name)
    ) {
      throw new BadRequestException('Invalid node name');
    }
  }

  private validateHost(host: string) {
    if (
      typeof host !== 'string' ||
      host.length < 1 ||
      host.length > 253
    ) {
      throw new BadRequestException('Invalid host');
    }

    if (isIP(host)) {
      return;
    }

    const hostnamePattern =
      /^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

    if (!hostnamePattern.test(host)) {
      throw new BadRequestException('Invalid host');
    }
  }

  private validatePort(port: number) {
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new BadRequestException('Invalid port');
    }
  }

  private validateMaxUsers(maxUsers: number) {
    if (
      !Number.isInteger(maxUsers) ||
      maxUsers < 1 ||
      maxUsers > 100000
    ) {
      throw new BadRequestException('Invalid maxUsers');
    }
  }

  private validatePublicKey(publicKey: string) {
    if (
      typeof publicKey !== 'string' ||
      publicKey.length < 20 ||
      publicKey.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(publicKey)
    ) {
      throw new BadRequestException('Invalid publicKey');
    }
  }

  private validateShortId(shortId: string) {
    if (
      typeof shortId !== 'string' ||
      !/^[a-fA-F0-9]{2,32}$/.test(shortId)
    ) {
      throw new BadRequestException('Invalid shortId');
    }
  }

  private validateSni(sni: string) {
    if (
      typeof sni !== 'string' ||
      sni.length < 1 ||
      sni.length > 253
    ) {
      throw new BadRequestException('Invalid sni');
    }

    const hostnamePattern =
      /^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

    if (!hostnamePattern.test(sni)) {
      throw new BadRequestException('Invalid sni');
    }
  }

  private validateInboundTag(inboundTag: string) {
    if (
      inboundTag.length < 1 ||
      inboundTag.length > 64 ||
      !/^[a-zA-Z0-9_.-]+$/.test(inboundTag)
    ) {
      throw new BadRequestException('Invalid inboundTag');
    }
  }

  private validateFingerprint(fingerprint: string) {
    if (
      fingerprint.length < 1 ||
      fingerprint.length > 32 ||
      !/^[a-zA-Z0-9_.-]+$/.test(fingerprint)
    ) {
      throw new BadRequestException('Invalid fingerprint');
    }
  }

  @Post()
  async register(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: RegisterNodeBody,
  ) {
    const expected =
  this.config.get<string>('NODE_REGISTER_TOKEN');

    const prefix = 'Bearer ';

    if (
      !expected ||
      !authorization ||
      !authorization.startsWith(prefix)
    ) {
      throw new UnauthorizedException();
    }

    const provided =
      authorization.slice(prefix.length);

    const expectedBuffer =
      Buffer.from(expected);

    const providedBuffer =
      Buffer.from(provided);

    if (
      expectedBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(
        expectedBuffer,
        providedBuffer,
      )
    ) {
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

    const port = body.port ?? 443;
    const maxUsers = body.maxUsers ?? 50;
    const inboundTag =
      body.inboundTag ?? 'vless-reality';
    const fingerprint =
      body.fingerprint ?? 'chrome';

    this.validateName(body.name);
    this.validateHost(body.host);
    this.validatePort(port);
    this.validateMaxUsers(maxUsers);
    this.validatePublicKey(body.publicKey);
    this.validateShortId(body.shortId);
    this.validateSni(body.sni);
    this.validateInboundTag(inboundTag);
    this.validateFingerprint(fingerprint);

    const existing = await this.prisma.node.findFirst({
      where: {
        host: body.host,
        port,
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
          maxUsers,
          publicKey: body.publicKey,
          shortId: body.shortId,
          sni: body.sni,
          inboundTag,
          fingerprint,
          isActive: false,
        },
      });

      const tunnel =
        await this.tunnel.setupTunnel(updated.id);

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
        port,

        apiHost: null,
        apiPort: 10085,

        inboundTag,

        type: body.type as NodeType,
        maxUsers,

        publicKey: body.publicKey,
        shortId: body.shortId,
        sni: body.sni,
        fingerprint,

        isActive: false,
      },
    });

    const tunnel =
      await this.tunnel.setupTunnel(node.id);

    return {
      ok: true,
      action: 'created',
      nodeId: node.id,
      tunnel,
    };
  }
}
