# Maintained Nitro Pose

운동 인식과 카운터를 다른 Expo 앱에 설치해 사용하는 독립 라이브러리다. 원본 `Gautham495/react-native-nitro-pose-exercises`의 **v1.1.19 (`69cdf4e`)**를 기반으로 하며 [MIT 라이선스](LICENSE)와 원저자 표기를 유지한다.

## 원본 대비 변경

| 영역 | 변경 목적과 범위 |
| --- | --- |
| [Android](android/) | 원본 ML Kit에 비동기 추론·중복 처리 방지·오래된 결과 차단 추가 |
| [iOS](ios/) | 원본 Apple Vision·관절 변환·방향 처리 유지. 결과 번호·처리시간·휴대폰 흔들림 입력 추가 |
| [공통 카운터](src/counter/) | 관절 추적과 Full/Knee 푸시업 판정을 순수 TS로 분리. 새 운동은 이 영역에서 확장 |
| [카메라 연결](src/camera/) | worker·JNI 연결·프레임 수명을 라이브러리에서 관리해 외부 패키지 패치 제거 |
| [스켈레톤](src/overlay/) | 청록색 선·흰색 관절을 독립 모듈로 제공. iOS 예제의 화면 투영은 원본 방식 유지 |
| [Expo 연동](plugin/) | 권한·Android 최소 SDK 설정 플러그인과 표준 설치 방식의 [예제](example/) 제공 |

공통 카운터의 지원 범위는 Full/Knee 푸시업이다. 원본 운동 API는 호환성을 위해 유지한다. 예제의 worker 상태는 100ms 간격(판정 이벤트는 즉시), 진단 표시는 250ms 간격, 확정 횟수는 즉시 갱신한다.

## 앱에 설치

패키지: `@enfp-dev-studio/react-native-nitro-pose-exercises` · **1.1.19-enfp.2**. 기준은 **Node 22.13+ / pnpm 12.3.4 / Expo 57.0.20 / RN 0.86.3 / React 19.2.3**이며 외부 의존성 버전은 [compatibility.json](compatibility.json)에 고정한다.

앱의 `pnpm-workspace.yaml`에 다음 빌드 허용 항목을 합친다. Git 항목은 이 저장소에서 가져오는 커밋의 빌드를 허용한다. [pnpm 설정](https://pnpm.io/settings/build#allowbuilds)

```yaml
allowBuilds:
  "@shopify/react-native-skia": true
  "@enfp-dev-studio/react-native-nitro-pose-exercises@git+https://github.com/enfp-dev-studio/react-native-nitro-pose-exercises.git": true
```

1. `compatibility.json`의 `hostDependencies`·`runtimeDependencies`를 앱에 설치한다. 원본 패키지와 이 포크를 함께 설치하지 않는다.
2. `pnpm add "git+https://github.com/enfp-dev-studio/react-native-nitro-pose-exercises.git#<커밋해시>"`로 원격에 반영된 커밋을 설치하고 manifest·lockfile을 보관한다.
3. Expo `plugins`에 `"@enfp-dev-studio/react-native-nitro-pose-exercises"`를 등록한다. 카메라·모션 권한 설명과 Android 최소 SDK 26을 설정하며 기존의 더 높은 설정은 보존한다.
4. `pnpm peers check` 후 `pnpm exec expo run:android` 또는 `pnpm exec expo run:ios --device`로 빌드한다. Expo Go는 지원하지 않는다.

Git 설치 시 `prepare`, 패키징 시 `prepack`이 `bob build`로 JS·타입·Nitro 바인딩을 생성한다. Android ML Kit는 Gradle, iOS Vision은 시스템 프레임워크로 연결된다. [Bob 빌드](https://oss.callstack.com/react-native-builder-bob/build), [pnpm Git 설치](https://pnpm.io/package-sources#git-repository)

## 개발·연동

```sh
pnpm install
pnpm --dir example install
pnpm run example:ios --device
# Android: pnpm run example:android
```

최초 루트 설치 시 자동 빌드하며 예제는 `file:..`로 라이브러리를 설치한다. 소스 수정 후 `pnpm run build`와 `pnpm --dir example install`로 갱신한다. 네이티브 변경 시 앱도 다시 빌드한다.

- `/camera`의 `usePoseFrameOutput`을 사용한다. 비동기 `onFrame`은 Promise를 반환하고, 프레임 해제는 훅에 맡긴다.
- 새 `resultVersion`마다 `/counter`를 한 번 실행한다. 판정 입력에 표시용 반전·크롭을 적용하지 않는다. Android 비동기 API는 관절 추론용이며, iOS는 원본 네이티브 세션 시작이 필요하다.
- 세션 종료 시 새 프레임을 막고 진행 중 결과를 기다린 뒤 최종 횟수를 읽는다. [App.tsx](example/src/App.tsx)와 [PoseCamera.tsx](example/src/PoseCamera.tsx)를 참고한다.

`nitrogen/generated/`는 Nitro 계약에서 재생성한다. 저장·화면 이동·캐릭터 성장 등 앱 기능은 수신 앱에서 구현한다.

## 검증

타입 검사·테스트 70개, 소스만 있는 로컬 Git 설치의 자동 빌드·exports·peer·Expo 설정, 예제 설치·Android JS 번들과 주요 의존성 단일 로딩을 확인했다. Android에서는 카메라 추론·백그라운드 복귀·종료·재시작, iPhone 13 mini에서는 빌드·설치·기본 카메라·스켈레톤 동작을 확인했다.

재검증 명령: `pnpm run typecheck`, `pnpm test`, `pnpm --dir example typecheck`, `pnpm run test:package`, `pnpm run test:git-install`.

실제 운동 횟수의 정확도와 자세·가림·회전에 따른 추가 튜닝은 후속 작업이다. 원격 HTTPS 설치는 로컬 Git 설치 검사와 별도로 확인해야 한다.
