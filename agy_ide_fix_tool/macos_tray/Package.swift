// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "AgySessionTray",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "AgySessionTray", targets: ["AgySessionTray"])
    ],
    targets: [
        .executableTarget(
            name: "AgySessionTray"
        )
    ]
)
