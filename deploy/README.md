# 服务器部署

服务器使用 systemd 常驻运行，项目采用 releases/current/shared 目录结构。

服务监听内网端口 38571；NAT 服务器需在供应商面板将一个公网 TCP 端口映射到该端口。

服务器不能访问 GitHub。发布时必须在开发机本地打包并通过 SCP 直传：

```powershell
git archive --format=tar.gz --prefix=ai-trpg-game/ -o deploy/ai-trpg-game-<commit>.tar.gz HEAD
scp deploy/ai-trpg-game-<commit>.tar.gz myserver:/tmp/ai-trpg-game.tar.gz
scp deploy/update.sh myserver:/tmp/update-ai-trpg-game
ssh myserver "bash /tmp/update-ai-trpg-game /tmp/ai-trpg-game.tar.gz"
```

服务器上的更新脚本只读取本地压缩包，不再访问 GitHub。若使用默认上传路径，可执行：

```bash
/usr/local/sbin/update-ai-trpg-game /tmp/ai-trpg-game.tar.gz
```

查看状态与日志：

```bash
systemctl status ai-trpg-game
journalctl -u ai-trpg-game -f
```
