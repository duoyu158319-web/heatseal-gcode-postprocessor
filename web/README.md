# 热封 G-code 后处理器

纯浏览器本地工具，用于读取 Bambu Studio 导出的 `.gcode.3mf`，识别层、主体 ID 与闭合墙轨迹，并插入暂停及无挤出复走流程。

## 本地运行

```powershell
node server.mjs
```

打开 `http://127.0.0.1:4173`。上传文件不会离开浏览器。

## 当前规则

- 暂停位置按打印层号选择，可配置多个暂停点。
- 每个暂停点可选“仅暂停”或“暂停后无挤出复走”。
- 复走来源固定为暂停层下方一层，Z 为该层顶面加 `0.01 mm`。
- 圈数从识别出的最大闭合墙轨迹开始向内选择。
- 速度倍率使用 `0.0–1.0` 滑块，步长为 `0.1`；默认 `0.1`。复走时 `0` 无有效速度，导出会提示至少选择 `0.1`。
- 导出时更新 `Metadata/plate_1.gcode.md5` 和 `custom_gcode_per_layer.xml`。
- 主体 ID 和同层主体切换位置已经进入解析数据模型，方便扩展“主体之间暂停”。

## 验证

```powershell
node --test core.test.mjs
node verify-real.cjs
node verify-package.cjs
```
