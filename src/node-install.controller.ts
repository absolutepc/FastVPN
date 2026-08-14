import {
  Controller,
  Get,
  Param,
  Res,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { readFile } from 'fs/promises';
import { join } from 'path';

@Controller('node-install')
export class NodeInstallController {
  constructor(private readonly config: ConfigService) {}

  @Get(':token')
  async getInstaller(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    const expected = this.config.get<string>('NODE_INSTALL_TOKEN');

    if (!expected || token !== expected) {
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

