class ClaudeInMobile < Formula
  desc "Fast native CLI for mobile device automation and store management"
  homepage "https://github.com/AlexGladkov/claude-in-mobile"
  version "3.5.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/AlexGladkov/claude-in-mobile/releases/download/v3.5.0/claude-in-mobile-3.5.0-darwin-arm64.tar.gz"
      sha256 "421fb53ab02b879faf7fed703ff84809686ada04b27afa487eb59cf6bf4020f7"
    end

    on_intel do
      url "https://github.com/AlexGladkov/claude-in-mobile/releases/download/v3.5.0/claude-in-mobile-3.5.0-darwin-x86_64.tar.gz"
      sha256 "26f3b4fb0a45f268e5f98ac8d62127001fad7885bd6969d3abcdbcca79112772"
    end
  end

  def install
    bin.install "claude-in-mobile"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/claude-in-mobile --version")
  end
end
