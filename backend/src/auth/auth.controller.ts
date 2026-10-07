import { Body, Controller, Get, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Db } from '../db/db.service';
import { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, Public } from './decorators';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });

@Controller('api/auth')
export class AuthController {
  constructor(private db: Db, private jwt: JwtService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>) {
    const row = await this.db.one<AuthUser & { passwordHash: string }>(
      'SELECT id, email, full_name AS "fullName", role, password_hash AS "passwordHash" FROM app_user WHERE lower(email) = lower($1)',
      [body.email]);
    if (!row || !(await bcrypt.compare(body.password, row.passwordHash))) throw new UnauthorizedException('Wrong email or password');
    const { passwordHash: _, ...user } = row;
    return { token: await this.jwt.signAsync({ sub: user.id }), user };
  }

  @Public()
  @Get('demo-accounts')
  async demoAccounts() {
    // Public list of seeded demo logins so portfolio visitors can try every role.
    return this.db.many(
      `SELECT u.email, u.full_name AS "fullName", u.role,
              (SELECT p.name || ' · ' || un.label FROM unit un JOIN property p ON p.id = un.property_id WHERE un.tenant_id = u.id LIMIT 1) AS detail
         FROM app_user u WHERE u.email LIKE '%@demo.fixflow.dev'
        ORDER BY CASE u.role WHEN 'MANAGER' THEN 0 WHEN 'TECHNICIAN' THEN 1 ELSE 2 END, u.full_name`);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
