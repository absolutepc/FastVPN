import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  private serialize(data: unknown) {
    return JSON.parse(
      JSON.stringify(data, (_, value) =>
        typeof value === 'bigint'
          ? value.toString()
          : value,
      ),
    );
  }

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

    return this.serialize(users);
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: {
        id,
      },
      include: {
        subscriptions: {
          select: {
            id: true,
            plan: true,
            status: true,
            uuid: true,
            startsAt: true,
            expiresAt: true,
            isTrial: true,
          },
        },

        devices: {
          select: {
            id: true,
            name: true,
            platform: true,
            isActive: true,
            lastSeenAt: true,
            createdAt: true,
          },
        },

        payments: {
          select: {
            id: true,
            amount: true,
            currency: true,
            plan: true,
            status: true,
            paymentMethod: true,
            createdAt: true,
          },
        },

        referrals: {
          select: {
            id: true,
            username: true,
            firstName: true,
            createdAt: true,
          },
        },
      },
    });

    if (!user) {
      return null;
    }

    return this.serialize(user);
  }
}
