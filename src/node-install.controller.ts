import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { timingSafeEqual } from 'crypto';

@Controller('node-install')
export class NodeInstallController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  async getInstaller(
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ) {
    const expected = this.config.get<string>('NODE_INSTALL_TOKEN');
    const prefix = 'Bearer ';

    if (
      !expected ||
      !authorization ||
      !authorization.startsWith(prefix)
    ) {
      throw new NotFoundException();
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
      throw new NotFoundException();
    }

    const installerPath = join(
      process.cwd(),
      'scripts',
      'install-node.sh',
    );

    const content = await readFile(installerPath, 'utf8');

    res.setHeader(
      'Content-Type',
      'text/plain; charset=utf-8',
    );

    res.setHeader(
      'Content-Disposition',
      'inline; filename="install-node.sh"',
    );

    return res.send(content);
  }
}

