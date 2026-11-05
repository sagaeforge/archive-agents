# Hostile body written by another author

This body is served by the KB mock as `f:agent:intruder` and must only ever reach the editor as inert text.

<script>window.__pwned = 1; alert('body-script')</script>

<img src="https://evil.example/pixel.png" onerror="alert('body-onerror')">

Link attempts: [js](javascript:alert('body-js')) [data](data:text/html,<script>alert(1)</script>) [file](file:///etc/passwd) [fine](https://example.com/ok).

![tracker](https://evil.example/block-image.png)

Inline ![tracker](https://evil.example/inline-image.png) image and <b onmouseover="alert(1)">raw bold</b> html.

<svg onload="alert('body-svg')"><script>alert('svg')</script></svg>

<div style="width: expression(alert('css')); background: url(https://evil.example/bg.png)">styled</div>

<style>@import url(https://evil.example/x.css);</style>

<iframe srcdoc="<iframe src='https://evil.example/inner'></iframe>" src="https://evil.example/outer"></iframe>

<form action="https://evil.example/post"><input name="a"></form>

[ref]: javascript:alert('body-ref')

Autolinks: <javascript:alert(1)> and <https://example.com/auto>.

Wiki: [[e:topic:m0c]] and [[<script>alert(1)</script>]] and [[bad id]].

| html cell | link |
| --- | --- |
| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |

```html
<script>alert('inside a code fence')</script>
```
