# 服务器部署

服务器使用 systemd 常驻运行，项目采用 releases/current/shared 目录结构。

更新最新版：

```bash
sudo /usr/local/sbin/update-ai-trpg-game
```

查看状态与日志：

```bash
systemctl status ai-trpg-game
journalctl -u ai-trpg-game -f
```
