# 热封 G-code 后处理器

纯浏览器本地工具，用于读取 Bambu Studio 导出的 `.gcode.3mf`，识别分层、已有暂停与连续挤出打印线，并在暂停后插入无挤出热封流程。

## 本地运行

```powershell
node server.mjs
```

打开 `http://127.0.0.1:4173`。上传文件不会离开浏览器。

## 当前规则

- 只有 Bambu Studio 已包含 `M400 U1` 的暂停层可以配置，可配置多个暂停点。
- 复走来源固定为暂停层下方一层，Z 为该层顶面加 `0.01 mm`。
- 页面按 G-code 出现顺序列出该层全部连续挤出打印线（开放或闭合），由用户勾选需要热封的线。
- 轨迹可从画布或编号图例直接选择，参数面板始终显示当前线。
- 速度倍率使用 `0.1–1.0` 滑块，步长为 `0.1`；默认 `0.1`。
- 每条已选择打印线均可独立重复热封 `1–3` 遍，暂停层热封不执行轨迹偏移。
- 导出时更新对应的 `Metadata/plate_*.gcode.md5`。

## 验证

```powershell
node --test core.test.mjs
node verify-real.cjs
node verify-package.cjs
```
