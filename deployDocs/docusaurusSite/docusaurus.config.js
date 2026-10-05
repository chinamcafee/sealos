// @ts-check
// Note: type annotations require typechecking, which is not enabled by default.
const lightCodeTheme = require('prism-react-renderer').themes.github;
const darkCodeTheme = require('prism-react-renderer').themes.dracula;

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Sealos 本地构建与部署指南',
  tagline: '在 Mac (M 芯片) 上从源码构建 sealos 全部组件并在本地 K8s 环境全量部署',
  favicon: 'img/favicon.ico',

  url: 'http://localhost',
  baseUrl: '/',

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'zh-CN',
    locales: ['zh-CN'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        title: 'Sealos 构建部署指南',
        logo: {
          alt: 'Sealos Logo',
          src: 'img/logo.svg',
        },
        items: [
          {
            type: 'doc',
            docId: 'intro/architecture',
            position: 'left',
            label: '指南文档',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: '文档',
            items: [
              {
                label: '项目架构总览',
                to: '/docs/intro/architecture',
              },
              {
                label: '全量部署',
                to: '/docs/deploy/full-deployment',
              },
            ],
          },
          {
            title: '更多',
            items: [
              {
                label: 'labring/sealos',
                href: 'https://github.com/labring/sealos',
              },
              {
                label: 'sealos 官网',
                href: 'https://sealos.io',
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Built from labring/sealos source.`,
      },
      prism: {
        theme: lightCodeTheme,
        darkTheme: darkCodeTheme,
        additionalLanguages: ['bash', 'go', 'yaml', 'json', 'docker', 'hcl', 'makefile'],
      },
    }),
};

module.exports = config;
