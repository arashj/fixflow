import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Db } from '../db/db.service';
import { AuthUser, Role } from '../common/types';
import { IS_PUBLIC, ROLES } from './decorators';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService, private db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing token');
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const user = await this.db.one<AuthUser>(
      'SELECT id, email, full_name AS "fullName", role FROM app_user WHERE id = $1', [payload.sub]);
    if (!user) throw new UnauthorizedException('User no longer exists');
    req.user = user;
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, targets);
    if (roles?.length && !roles.includes(user.role)) throw new ForbiddenException('Not allowed for your role');
    return true;
  }
}
