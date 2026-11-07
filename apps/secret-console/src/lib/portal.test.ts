import { describe, expect, it } from 'vitest';
import {
  PLATFORM_TENANT_ID,
  buildPortalUrl,
  fallbackPlatformUrl,
  filterPortals,
  portalCatalogUrl,
  rootDomainOf,
} from './portal';

describe('rootDomainOf', () => {
  it('去掉门户子域', () => {
    expect(rootDomainOf('secret.autional.com')).toBe('autional.com');
    expect(rootDomainOf('secret.autional.cn')).toBe('autional.cn');
    expect(rootDomainOf('config.autional.com')).toBe('autional.com');
  });

  it('保留两段式 TLD 三段根', () => {
    expect(rootDomainOf('secret.autional.com.cn')).toBe('autional.com.cn');
  });

  it('本机 / IP 原样返回', () => {
    expect(rootDomainOf('localhost')).toBe('localhost');
    expect(rootDomainOf('127.0.0.1')).toBe('127.0.0.1');
    expect(rootDomainOf('::1')).toBe('::1');
  });

  it('.local 视为三段根', () => {
    expect(rootDomainOf('secret.iam.tianv.local')).toBe('iam.tianv.local');
  });
});

describe('buildPortalUrl', () => {
  it('无 portal 配置时用 code 作子域', () => {
    expect(buildPortalUrl({ code: 'admin', name: 'Admin' }, 'autional.com', 'https:')).toBe(
      'https://admin.autional.com',
    );
  });

  it('使用 config.portal.host / base', () => {
    expect(
      buildPortalUrl({ code: 'secret', name: '密钥中心', config: { portal: { host: 'secret', base: '/console' } } }, 'autional.cn', 'https:'),
    ).toBe('https://secret.autional.cn/console');
  });

  it('host 已是 FQDN 时不重复拼根域', () => {
    expect(
      buildPortalUrl({ code: 'x', name: 'x', config: { portal: { host: 'secret.autional.com' } } }, 'autional.com', 'https:'),
    ).toBe('https://secret.autional.com');
  });

  it('缺根域时返回空串（调用方按不可跳转处理）', () => {
    expect(buildPortalUrl({ code: 'admin', name: 'Admin' }, '', 'https:')).toBe('');
  });
});

describe('filterPortals', () => {
  const rows = [
    { code: 'auth', name: 'Sign-in' },
    { code: 'landing', name: 'Landing' },
    { code: 'authenticator', name: 'App' },
    { code: 'admin', name: 'Admin' },
    { code: 'security', name: 'Security' },
    { code: 'secret', name: '密钥中心' },
    { code: 'platform', name: 'Platform' },
    { code: 'brand', name: 'Brand' },
  ];

  it('排除 auth/landing/authenticator', () => {
    const codes = filterPortals(rows, { tenantId: PLATFORM_TENANT_ID }).map((item) => item.code);
    expect(codes).not.toContain('auth');
    expect(codes).not.toContain('landing');
    expect(codes).not.toContain('authenticator');
  });

  it('platform 仅平台租户可见', () => {
    const platform = filterPortals(rows, { tenantId: PLATFORM_TENANT_ID }).map((item) => item.code);
    expect(platform).toContain('platform');
    const other = filterPortals(rows, { tenantId: '01KTENANT0000000000000000' }).map((item) => item.code);
    expect(other).not.toContain('platform');
  });

  it('管理面门户按角色过滤；令牌未带角色时不误伤', () => {
    const member = filterPortals(rows, { roles: ['member'] }).map((item) => item.code);
    expect(member).not.toContain('admin');
    expect(member).not.toContain('security');
    expect(member).not.toContain('secret');

    const noRoles = filterPortals(rows, { roles: [] }).map((item) => item.code);
    expect(noRoles).toContain('admin');
    expect(noRoles).toContain('secret');
  });

  it('管理面角色可见 admin/security/secret', () => {
    const codes = filterPortals(rows, { roles: ['security_admin'] }).map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(['admin', 'security', 'secret']));
  });
});

describe('portalCatalogUrl / fallbackPlatformUrl', () => {
  it('目录端点带 type/is_platform/status 与编码后的租户', () => {
    const url = portalCatalogUrl('01K/ABC');
    expect(url).toContain('/tenants/01K%2FABC/applications');
    expect(url).toContain('type=portal');
    expect(url).toContain('is_platform=true');
    expect(url).toContain('status=active');
  });

  it('降级出口按站点后缀选 cn / com', () => {
    expect(fallbackPlatformUrl('secret.autional.cn')).toBe('https://platform.autional.cn');
    expect(fallbackPlatformUrl('secret.autional.com')).toBe('https://platform.autional.com');
    expect(fallbackPlatformUrl('localhost')).toBe('https://platform.autional.com');
  });
});
