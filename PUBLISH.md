# 发布到 GitHub 的步骤

> 这份清单只在你**第一次发布**时需要。之后日常提交不用看。

## 一、先在 GitHub 建仓库

1. 打开 https://github.com/new
2. **Repository name** 填：`dsh-whale-workbuddy-bridge`
3. **Description** 填：
   `把 WorkBuddy / CodeBuddy 积分接进 dsh-whale-widget：余额、每轮积分、今日累计`
4. 选 **Public**（要给别人用就必须公开）
5. **不要**勾 "Add a README file" / "Add .gitignore" / "Choose a license"
   —— 本地已经有了，勾了会造成首次推送冲突
6. 点 **Create repository**

建完 GitHub 会显示一段命令，用下面的替代它。

## 二、占位符已填好

`package.json` 的 `repository` / `bugs` 和 README 里的 `git clone` 地址都已指向
`https://github.com/lazarusczh/dsh-whale-workbuddy-bridge`。换账号时才需要再改这三处。

## 三、推送

在本目录执行：

```bash
git remote add origin https://github.com/lazarusczh/dsh-whale-workbuddy-bridge.git
git branch -M main
git push -u origin main
```

首次推送会让你登录。**推荐用 Personal Access Token**（GitHub 2021 年后不再接受密码）：

- 生成：https://github.com/settings/tokens → "Generate new token (classic)" → 勾 `repo` → 复制
- 推送时 Username 填 `lazarusczh`，Password 粘 token
- 想让 Git 记住：`git config --global credential.helper manager`

或者用 GitHub CLI（更省事）：

```bash
gh auth login
gh repo create dsh-whale-workbuddy-bridge --public --source=. --push
```

## 四、推送后检查

1. 打开仓库页面，确认 **文件列表里没有** `.dshw-*.json` / `.workbuddy-*.json` / `.credentials.yaml`
2. 确认 `LICENSE` 被识别（页面右侧会显示 MIT）
3. 确认 README 正常渲染（表格、代码块）
4. 在别人视角检查一遍：仓库根目录应该只有 31 个左右的源文件

## 五、可选但建议

- **加 topics**（仓库页右上 ⚙️）：`dsh`、`deepseek-harness`、`workbuddy`、`codebuddy`、`whale-widget`
- **建一个 Release**：tag `v0.1.0`，说明写「首个可用版本」
- **在 README 顶部加一张截图**（挂件侧栏显示积分的样子）—— 这类项目截图比文字有说服力

## 六、如果以后要发 npm

```bash
npm login
npm publish --access public
```

`package.json` 的 `files` 已经限定只发布 `lib` / `cordis.patch.yml` / `README.md` / `LICENSE`，
测试文件不会被打包。

---

## 安全自查（每次推送前）

```bash
# 1. 暂存区里有没有疑似 token
git grep -nIE "(Bearer [A-Za-z0-9_.-]{25,}|eyJ[A-Za-z0-9_-]{20,})" -- .

# 2. 有没有真实账号标识（把 lazarusczh 换成你的 GitHub 用户名再跑）
git grep -nI "lazarusczh\|uin\|uid" -- . | grep -v "不返回\|不打印\|占位"

# 3. 确认运行产物没被跟踪
git ls-files | grep -E "\.dshw-|\.workbuddy-|credentials" || echo "干净"
```

三条都空 → 可以推。
