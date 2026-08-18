# HTML 발표 덱 사용 가이드

새 발표 덱의 진입점은 `web/public/presentation/index.html`이다. 기존 주소인 `/deck.html`도 자동으로 새 덱으로 이동한다.

## 실행

프로젝트 루트에서 정적 서버 또는 기존 서버를 실행한 뒤 다음 주소를 연다.

```text
http://localhost:8766/deck.html#slide-1
```

발표 중에는 `← / →` 또는 `PageUp / PageDown`으로 넘기고, `F`로 전체화면, `O`로 15장 목차를 연다.

## 영상 교체

영상 파일은 아직 넣지 않고 두 개의 자리만 만들었다.

- `web/public/presentation/slides/story/01-hook.html`
  - 아침에 옷을 찾다가 늦는 영상
- `web/public/presentation/slides/story/14-validation.html`
  - 사용 후기 또는 실물 검증 영상

각 파일의 `.video-slot`에 있는 `data-video-src=""`를 다음처럼 바꾸면 된다.

```html
data-video-src="/assets/video/morning-search.mp4"
```

영상이 연결되지 않은 상태에서는 발표용 플레이스홀더가 그대로 보인다.

## 라이브 앱 연결

슬라이드 13은 왼쪽을 스마트폰 중계, 오른쪽을 직접 만든 앱으로 고정했다. 앱이 완성되면 URL만 넘기면 된다.

```text
http://localhost:8766/presentation/index.html?desktop=http%3A%2F%2Flocalhost%3A3000%2Fapp&mobile=http%3A%2F%2Flocalhost%3A3000%2Frelay#slide-13
```

또는 슬라이드 13을 직접 열 때 `?app=...&phone=...`을 사용할 수 있다. 앱과 중계 화면은 `postMessage` 이벤트를 통해 `command.queued`, `gateway.sent`, `hanger.command`, `command.ack`, `hanger.led`를 보내면 하단 이벤트 미러가 실제 흐름을 반영한다.

## 발표 전 교체할 내용

- `[발표자 이름]`
- `[실제 비율]`과 설문 원본
- 시장분석의 현재 입력값: 글로벌 스마트홈 시장 2026년 `180.12B USD`, 2034년 `848.47B USD`, CAGR `21.40%`
- 시장 출처: [Fortune Business Insights — Smart Home Market](https://www.fortunebusinessinsights.com/industry-reports/smart-home-market-101900)
- 영상 파일과 실제 앱/중계 URL

시장 수치와 설문 수치는 근거가 연결되기 전까지 임의의 숫자로 바꾸지 않는다. 대본 원본은 `docs/PRESENTATION_SCRIPT_8MIN.md`이다.
