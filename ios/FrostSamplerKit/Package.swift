// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FrostSamplerKit",
    products: [
        .library(name: "FrostSamplerKit", targets: ["FrostSamplerKit"]),
    ],
    targets: [
        .target(
            name: "FrostSamplerKit",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "FrostSamplerKitTests",
            dependencies: ["FrostSamplerKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
