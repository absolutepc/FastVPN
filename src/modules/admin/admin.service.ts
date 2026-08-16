import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async getUsers() {
  const users = await this.prisma.user.findMany({
    orderBy: {
      createdAt: 'desc',
    },
    include: {
      subscriptions: {
        select: {
          plan: true,
          status: true,
          expiresAt: true,
          isTrial: true,
        },
      },
    },
  });

  return JSON.parse(
    JSON.stringify(users, (_, value) =>
      typeof value === 'bigint'
        ? value.toString()
        : value,
     ),
   );
 }
}
