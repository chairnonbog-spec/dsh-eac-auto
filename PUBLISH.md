# 发布到 GitHub + npm

本机**没有** GitHub 凭据、npm token 和 gh CLI，最后两步需要你的账号。

## 已就绪

- 包名 `dsh-eac-auto`（已确认 npm 可用，无 `private` 字段，MIT）
- `cordis.patch.yml`、README、INSTALL 里的包名已同步
- Git 仓库本地提交完成（19 文件，`dist/` 与 `scripts/investigation/` 已忽略）
- `pnpm pack` 产物 12 文件，已在干净目录实测安装并加载

## 一、建仓并推送

```powershell
winget install --id GitHub.cli
gh auth login
cd D:\Study\deepseek\projects\eac-auto
gh repo create dsh-eac-auto --public --source=. --push
```

不用 gh 的话：先在 https://github.com/new 建空仓库（不要加 README/license），然后：

```powershell
cd D:\Study\deepseek\projects\eac-auto
git remote add origin https://github.com/<你的用户名>/dsh-eac-auto.git
git push -u origin main
```

推送后把 `package.json` 里三处 `USERNAME` 换成你的用户名：

```powershell
(Get-Content package.json -Raw) -replace 'USERNAME', '你的用户名' | Set-Content package.json -NoNewline
git add package.json
git commit -m "chore: point repository URLs at the real repo"
git push
```

## 二、发布 npm

```powershell
cd D:\Study\deepseek\projects\eac-auto
npm login
npm whoami
npm publish
```

验证：

```powershell
npm view dsh-eac-auto version    # 应显示 1.0.0
```

## 三、发布前自检

```powershell
cd D:\Study\deepseek\projects\eac-auto
npm run check        # 四个文件语法检查
npm test             # 离线测试 + host 测试
npm pack --dry-run   # 确认只打 12 个文件，不含 scripts/dist
```

## 四、安装验证

在另一台 DSH 上：

```
dsh plugin add dsh-eac-auto
```

装完重启 DSH，模型选择器里应出现 **EAC AUTO**。

> 前置条件：必须先装并登录 `dsh-our-free-model`，否则名单为空。

## 升级版本

```powershell
npm version patch
git push --follow-tags
npm publish
```
